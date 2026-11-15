// Browser stand-in for Node's `fs`: @anchor-lang/core's browser bundle references it only in NodeWallet.local(),
// which the app never calls (wallets come from the Solana wallet adapter).
export default {};
