import { type Hex, concatHex, keccak256, numberToHex, size, sliceHex } from "viem";
import { consumerAccountBytecode } from "./abi";

/** Mirrors contracts/AccountFactoryDeployer.sol: each data chunk stays well below the 24 KB code-size limit. */
export const ACCOUNT_CODE_CHUNK_SIZE = 12_000;

/**
 * Creation code for a CodeChunkStore data contract holding `data` (mirrors CodeChunkStore.creationCode):
 * a 12-byte loader, then 0x00 (STOP, so calling the chunk does nothing), then the data.
 */
export function chunkCreationCode(data: Hex): Hex {
  const len = size(data) + 1;
  return concatHex([`0x61${numberToHex(len, { size: 2 }).slice(2)}80600c6000396000f3`, "0x00", data]);
}

/** ConsumerAccount creation code split into data-contract creation codes, plus the hash the factory checks. */
export function accountCodeChunks(chunkSize = ACCOUNT_CODE_CHUNK_SIZE): { chunks: Hex[]; codeHash: Hex } {
  const code = consumerAccountBytecode as Hex;
  const total = size(code);
  const chunks: Hex[] = [];
  for (let start = 0; start < total; start += chunkSize) {
    chunks.push(chunkCreationCode(sliceHex(code, start, Math.min(start + chunkSize, total))));
  }
  return { chunks, codeHash: keccak256(code) };
}
