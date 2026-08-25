// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IScoplRouterAdapterERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount)
        external returns (bool);
}

interface IScoplRouterAdapterPermit2 {
    function approve(
        address token,
        address spender,
        uint160 amount,
        uint48 expiration
    ) external;
}

interface IScoplRouterAdapterWETH is IScoplRouterAdapterERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @notice Minimal custodyless bridge between a SCOPL vault and one immutable
///         aggregation router.
/// @dev Router calldata remains flexible so the off-chain service can select a
///      V3, V4, or multi-hop path. Safety comes from a fixed controller/router,
///      exact input consumption, no retained balances, and the controller's
///      independent minimum-output and output-delta checks.
contract ScoplRouterSwapAdapter {
    error InvalidAmount();
    error InvalidContract();
    error InvalidRecipient();
    error NotController();
    error ReentrantCall();
    error RouterCodeChanged();
    error RouterCallFailed(bytes reason);
    error SlippageExceeded();
    error TransferFailed();

    address public immutable controller;
    address public immutable router;
    address public immutable permit2;
    address public immutable weth;
    bytes32 public immutable routerCodeHash;
    uint256 private reentrancyState = 1;

    modifier onlyController() {
        if (msg.sender != controller) revert NotController();
        _;
    }

    modifier nonReentrant() {
        if (reentrancyState != 1) revert ReentrantCall();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    constructor(
        address controllerAddress,
        address routerAddress,
        address permit2Address,
        address wethAddress
    ) {
        if (
            controllerAddress.code.length == 0 ||
            routerAddress.code.length == 0 ||
            permit2Address.code.length == 0 ||
            wethAddress.code.length == 0
        ) {
            revert InvalidContract();
        }
        controller = controllerAddress;
        router = routerAddress;
        permit2 = permit2Address;
        weth = wethAddress;
        routerCodeHash = routerAddress.codehash;
    }

    receive() external payable {
        if (msg.sender != router && msg.sender != weth) revert TransferFailed();
    }

    function executeSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minimumAmountOut,
        address recipient,
        bytes calldata data
    ) external onlyController nonReentrant {
        (uint8 nativeMode, bytes memory routerData) = abi.decode(
            data,
            (uint8, bytes)
        );
        _execute(
            tokenIn,
            tokenOut,
            amountIn,
            minimumAmountOut,
            recipient,
            nativeMode,
            routerData
        );
    }

    function _execute(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minimumAmountOut,
        address recipient,
        uint8 nativeMode,
        bytes memory routerData
    ) private returns (uint256 amountOut) {
        if (
            tokenIn == tokenOut ||
            tokenIn.code.length == 0 ||
            tokenOut.code.length == 0 ||
            amountIn == 0 ||
            minimumAmountOut == 0
        ) revert InvalidAmount();
        if (recipient == address(0) || recipient != controller) {
            revert InvalidRecipient();
        }
        if (
            nativeMode > 2 ||
            (nativeMode == 1 && tokenOut != weth) ||
            (nativeMode == 2 && tokenIn != weth)
        ) revert InvalidAmount();
        if (router.codehash != routerCodeHash) revert RouterCodeChanged();

        uint256 inputBefore = _balanceOf(tokenIn);
        uint256 outputBefore = _balanceOf(tokenOut);
        _safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        if (_balanceOf(tokenIn) - inputBefore != amountIn) revert TransferFailed();
        uint256 nativeBefore = address(this).balance;
        bool success;
        bytes memory result;
        if (nativeMode == 2) {
            IScoplRouterAdapterWETH(weth).withdraw(amountIn);
            (success, result) = router.call{value: amountIn}(routerData);
            if (!success) revert RouterCallFailed(result);
            if (address(this).balance != nativeBefore) revert TransferFailed();
        } else {
            if (amountIn > type(uint160).max) revert InvalidAmount();
            _forceApprove(tokenIn, permit2, amountIn);
            IScoplRouterAdapterPermit2(permit2).approve(
                tokenIn,
                router,
                uint160(amountIn),
                uint48(block.timestamp + 1 hours)
            );
            // Some immutable routers pull directly; Universal Router pulls
            // through Permit2. Both allowances are exact and cleared below.
            _forceApprove(tokenIn, router, amountIn);
            (success, result) = router.call(routerData);
            _forceApprove(tokenIn, router, 0);
            IScoplRouterAdapterPermit2(permit2).approve(tokenIn, router, 0, 0);
            _forceApprove(tokenIn, permit2, 0);
            if (!success) revert RouterCallFailed(result);
            if (nativeMode == 1) {
                uint256 nativeAmountOut = address(this).balance - nativeBefore;
                if (nativeAmountOut == 0) revert SlippageExceeded();
                IScoplRouterAdapterWETH(weth).deposit{value: nativeAmountOut}();
            }
        }
        if (address(this).balance != nativeBefore) revert TransferFailed();
        if (_balanceOf(tokenIn) != inputBefore) revert TransferFailed();
        uint256 outputAfter = _balanceOf(tokenOut);
        if (outputAfter < outputBefore) revert TransferFailed();
        amountOut = outputAfter - outputBefore;
        if (amountOut < minimumAmountOut) revert SlippageExceeded();
        _safeTransfer(tokenOut, recipient, amountOut);
    }

    function _balanceOf(address token) private view returns (uint256) {
        return IScoplRouterAdapterERC20(token).balanceOf(address(this));
    }

    function _safeTransfer(address token, address recipient, uint256 amount) private {
        (bool success, bytes memory result) = token.call(
            abi.encodeCall(IScoplRouterAdapterERC20.transfer, (recipient, amount))
        );
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert TransferFailed();
        }
    }

    function _safeTransferFrom(
        address token,
        address sender,
        address recipient,
        uint256 amount
    ) private {
        (bool success, bytes memory result) = token.call(
            abi.encodeCall(
                IScoplRouterAdapterERC20.transferFrom,
                (sender, recipient, amount)
            )
        );
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert TransferFailed();
        }
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        if (!_callApprove(token, spender, 0)) revert TransferFailed();
        if (amount != 0 && !_callApprove(token, spender, amount)) revert TransferFailed();
    }

    function _callApprove(address token, address spender, uint256 amount)
        private returns (bool)
    {
        (bool success, bytes memory result) = token.call(
            abi.encodeCall(IScoplRouterAdapterERC20.approve, (spender, amount))
        );
        return success &&
            (result.length == 0 || (result.length >= 32 && abi.decode(result, (bool))));
    }
}
