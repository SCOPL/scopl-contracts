import { keccak256 } from "viem";
import { robinhoodRpcRequest } from "./robinhood-rpc.mjs";

const expectedChainId = 4_663;
const dependencies = [
  {
    name: "v3 factory",
    address: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    codeHash:
      "0xec72b1abd1f2faee020cfea9c646bd8994f9fb389054f6e574f103a895091739"
  },
  {
    name: "v3 position manager",
    address: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
    codeHash:
      "0x0a493d1af3d0f25fed8efa205244ebee14114267a08647fc38c515c7cd6ead4f"
  },
  {
    name: "v3 swap router",
    address: "0xcaf681a66d020601342297493863e78c959e5cb2",
    codeHash:
      "0x6f36c378e272c6324c48f045182bcb54bd8ad654cf9ebd42e8893d52c4cb25dc"
  },
  {
    name: "v4 position manager",
    address: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    codeHash:
      "0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2"
  },
  {
    name: "v4 state view",
    address: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    codeHash:
      "0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6"
  },
  {
    name: "v4 pool manager",
    address: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    codeHash:
      "0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626"
  },
  {
    name: "WETH",
    address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    codeHash:
      "0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353"
  },
  {
    name: "universal router",
    address: "0x8876789976decbfcbbbe364623c63652db8c0904",
    codeHash:
      "0x2ce6aaaf9f4151f5e1cbf774668772f17f532ae11b15e9284fd0a072a8b0fbde"
  },
  {
    name: "Permit2",
    address: "0x000000000022d473030f116ddee9f6b43ac78ba3",
    codeHash:
      "0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca"
  }
];

async function rpc(method, params = [], id = 1) {
  return robinhoodRpcRequest(method, params, id);
}

const chainId = Number.parseInt(await rpc("eth_chainId"), 16);
if (chainId !== expectedChainId) {
  throw new Error(
    `Wrong chain: expected ${expectedChainId}, received ${chainId}`
  );
}

for (const [index, dependency] of dependencies.entries()) {
  const code = await rpc(
    "eth_getCode",
    [dependency.address, "latest"],
    index + 2
  );
  if (code === "0x") {
    throw new Error(`${dependency.name} has no runtime code`);
  }
  const actualHash = keccak256(code);
  if (actualHash !== dependency.codeHash) {
    throw new Error(
      `${dependency.name} code hash mismatch: ${actualHash}`
    );
  }
  console.log(
    `Verified ${dependency.name} at ${dependency.address} (${actualHash})`
  );
}

console.log(`Verified Robinhood Chain dependencies on chain ${chainId}`);
