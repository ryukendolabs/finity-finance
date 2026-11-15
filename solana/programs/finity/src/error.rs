use anchor_lang::prelude::*;

#[error_code]
pub enum FinityError {
    #[msg("Signer is not the protocol admin")]
    NotAdmin,
    #[msg("Signer is neither the keeper nor the admin")]
    NotKeeper,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Faucet amount is above the per-call cap")]
    FaucetCapExceeded,
    #[msg("Mint is not controlled by the protocol")]
    MintNotProtocolOwned,
    #[msg("Risk parameters must satisfy closed LTV <= max LTV < liquidation threshold < 100%")]
    InvalidRiskParams,
    #[msg("Symbol must be 1 to 8 bytes")]
    InvalidSymbol,
    #[msg("Price must be greater than zero")]
    InvalidPrice,
    #[msg("Price is older than the maximum allowed age")]
    StalePrice,
    #[msg("Not enough collateral in the position")]
    InsufficientCollateral,
    #[msg("Debt would exceed the borrow limit")]
    BorrowLimitExceeded,
    #[msg("Position has no debt")]
    NoDebt,
    #[msg("Position is healthy and cannot be liquidated")]
    PositionHealthy,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Not enough USDC liquidity in the market")]
    InsufficientLiquidity,
    #[msg("Market borrow cap reached")]
    BorrowCapExceeded,
    #[msg("Vault or market supply cap reached")]
    SupplyCapExceeded,
    #[msg("Signer is not the vault allocator")]
    NotAllocator,
    #[msg("Market accounts must be the vault's markets, in order")]
    WrongMarketAccounts,
    #[msg("The vault already has the maximum number of markets")]
    TooManyMarkets,
    #[msg("Queue must list distinct vault market indexes")]
    InvalidQueue,
    #[msg("Redeem requests must be passed in queue order")]
    WrongRedeemRequest,
    #[msg("Redeem request is not processed yet")]
    RequestNotProcessed,
    #[msg("Redeem request is already claimed")]
    RequestAlreadyClaimed,
    #[msg("Not enough vault liquidity to redeem now; queue a redeem request instead")]
    VaultIlliquid,
    #[msg("Amount is too small to mint any shares")]
    ZeroShares,
    #[msg("The stored scenario tail is too short for this computation")]
    ScenarioTailTooShort,
    #[msg("Borrowing is paused while the market reopens or during a corporate action")]
    BorrowPaused,
    #[msg("The closure has no known reopen time")]
    ClosureOpenEnded,
    #[msg("Liquidations only run while the market is in its regular session")]
    MarketNotOpen,
    #[msg("Sessions must be increasing, non-overlapping and of a scheduled closure type")]
    InvalidSessions,
    #[msg("The calendar is full")]
    CalendarFull,
    #[msg("Risk set does not belong to this market and closure type")]
    WrongRiskSet,
    #[msg("Scenario tail must be sorted ascending and at most 256 values")]
    InvalidScenarioSet,
    #[msg("Sigma may not fall more than 10% a day or below its floor")]
    SigmaDecreaseTooFast,
    #[msg("Signer is not the sigma oracle")]
    NotSigmaOracle,
    #[msg("Restriction must be Closed or Halted, at most 7 days, and never shorten an active one")]
    InvalidRestriction,
    #[msg("No epoch is open for this closure")]
    NoOpenEpoch,
    #[msg("An epoch is already open, or this one is not ready to open")]
    EpochNotReady,
    #[msg("The epoch is not ready to settle: a market has not finished its reopen")]
    EpochNotSettleable,
    #[msg("The epoch is not settled yet")]
    EpochNotSettled,
    #[msg("Cover can only be bought in the regular session before the Bell deadline")]
    CoverWindowClosed,
    #[msg("Loan-to-value is above the coverable limit")]
    LtvAboveCoverable,
    #[msg("Premium is above the maximum you accepted")]
    PremiumAboveMax,
    #[msg("The pool has no capacity left for this cover")]
    PoolCapacityExceeded,
    #[msg("This loan does not need action at the Bell")]
    BellNotNeeded,
    #[msg("Market does not belong to this pool")]
    WrongPool,
    #[msg("Joint column must hold exactly 256 scenarios")]
    InvalidJointColumn,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Position is healthy: nothing to auction")]
    NotLiquidatable,
    #[msg("This auction is not in the right phase for that")]
    WrongAuctionPhase,
    #[msg("The auction is full")]
    AuctionFull,
    #[msg("Bid price is below the reserve")]
    BidBelowReserve,
    #[msg("Reveal does not match the commitment")]
    CommitmentMismatch,
    #[msg("Revealed notional is above the declared maximum")]
    NotionalAboveMax,
    #[msg("Every bid of the auction must be passed, once")]
    WrongBidAccounts,
    #[msg("Lot entries must be fixed before bidding starts")]
    LotNotFixed,
    #[msg("The reopen is not finished: its auction has not settled")]
    ReopenNotDone,
    #[msg("Direct price pushes are disabled: prices come as signed reports")]
    KeeperPriceDisabled,
    #[msg("Not enough valid signed price reports for this market")]
    NotEnoughSignatures,
    #[msg("Signed report is stale, too far ahead, or older than the stored price")]
    ReportOutOfWindow,
    #[msg("Oracle signer set is invalid")]
    InvalidSigners,
    #[msg("Signer is not the guardian")]
    NotGuardian,
    #[msg("Borrowing is paused by the guardian")]
    GuardianBorrowPaused,
    #[msg("Gap Cover sales are paused by the guardian")]
    GuardianCoverPaused,
    #[msg("Haircut must be below max LTV and last at most 7 days")]
    InvalidHaircut,
    #[msg("The borrower switched auto-cover off for this loan")]
    AutoCoverOff,
    #[msg("The pool's cash is tied up in inventory or redemptions; try again once they settle")]
    PoolIlliquid,
    #[msg("The pool holds no inventory of this token to list")]
    NoInventory,
    #[msg("A GDA is already running for this inventory")]
    GdaRunning,
    #[msg("No GDA is running for this inventory")]
    GdaNotActive,
    #[msg("The GDA cost is above the buyer's maximum")]
    CostAboveMax,
    #[msg("T-Bill fund inventory is redeemed with the fund, not resold")]
    NavInventory,
    #[msg("Only T-Bill fund inventory can be redeemed")]
    NotNavInventory,
    #[msg("The fund has not fulfilled this redemption yet")]
    RedemptionNotReady,
    #[msg("This GDA can only be ended by the keeper or admin before it has run its course")]
    GdaStillRunning,
    #[msg("The account is already migrated")]
    AlreadyMigrated,
}
