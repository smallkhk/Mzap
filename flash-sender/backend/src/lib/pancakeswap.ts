/**
 * PancakeSwap V2 Router addresses and the ERC-20/Router ABI fragments this
 * app calls.
 *
 * Addresses are load-bearing: a wrong one here doesn't fail loudly, it sends
 * a real transaction to a contract that either doesn't exist or does
 * something else with the funds. Verified against the published
 * `@pancakeswap/smart-router` npm package's compiled source
 * (`V2_ROUTER_ADDRESS`) and `@pancakeswap/swap-sdk-evm` (`WBNB`), and
 * cross-checked for EIP-55 checksum validity — not copied from a webpage
 * summary, which is exactly the kind of place a single flipped character
 * would slip through unnoticed.
 */
import { getAddress } from 'ethers';

export const PANCAKE_V2_ROUTER: Record<number, string> = {
  56: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
  97: '0xD99D1c33F9fC3444f8101754aBC46c52416550D1',
};

export const WRAPPED_NATIVE: Record<number, string> = {
  56: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  97: '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd',
};

export const PANCAKE_V2_ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable returns (uint[] amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
] as const;

export const ERC20_APPROVE_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
] as const;

// Fails at import time, not mid-swap, if any address above were ever edited
// into something that isn't even a validly checksummed address.
for (const table of [PANCAKE_V2_ROUTER, WRAPPED_NATIVE]) {
  for (const address of Object.values(table)) getAddress(address);
}
