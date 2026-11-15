use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, MintTo, Token, TokenAccount},
};

use crate::{constants::*, error::FinityError, state::Config};

#[derive(Accounts)]
pub struct Faucet<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        constraint = mint.mint_authority == Some(config.key()).into() @ FinityError::MintNotProtocolOwned,
    )]
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Mints test tokens (stocks or USDC) to the caller, capped per call.
pub fn handle_faucet(ctx: Context<Faucet>, amount: u64) -> Result<()> {
    require!(amount > 0, FinityError::ZeroAmount);
    let cap = FAUCET_MAX_WHOLE
        .checked_mul(10u64.pow(ctx.accounts.mint.decimals as u32))
        .ok_or(FinityError::MathOverflow)?;
    require!(amount <= cap, FinityError::FaucetCapExceeded);

    let seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.user_token.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}
