// What the same trades would have cost in fees on other Solana terminals, at their published base fee per trade (tiers,
// referrals and rebates can lower them). Nought charges 0%. Used by the status bar's "Saved" chip and the PnL card.
export const TERMINALS = [['Axiom', 0.0095], ['Photon', 0.01], ['BullX', 0.01], ['GMGN', 0.01], ['Trojan', 0.01], ['BonkBot', 0.01]];
// SOL that `volumeSol` of trading would have paid in fees on each terminal
export const savedVs = (volumeSol) => TERMINALS.map(([name, rate]) => ({ name, rate, sol: (Number(volumeSol) || 0) * rate }));
