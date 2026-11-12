// IAmigos — the whip: arcade-style combo counting. No GNOME imports, so it can
// be tested with Node.
//
// Every lash within COMBO_WINDOW seconds of the previous one keeps the combo
// going; every 5 hits is a milestone, and the tier (named shout and how long
// the critters rush afterwards) grows with the combo.

export const COMBO_WINDOW = 1.2;   // s between lashes to keep the combo
export const SHOUT_LINGER = 1.0;   // s the combo label stays after the combo ends
export const MILESTONE_EVERY = 5;

// From the highest; `rush` is how many animation ticks the critters run faster.
export const TIERS = [
    {at: 50, key: 'legend', rush: 40},
    {at: 20, key: 'brutal', rush: 30},
    {at: 10, key: 'super', rush: 22},
    {at: 5, key: 'combo', rush: 16},
    {at: 1, key: null, rush: 10},
];

export function tierOf(count) {
    return TIERS.find(tier => count >= tier.at) ?? TIERS[TIERS.length - 1];
}

export class Combo {
    constructor() {
        this.count = 0;
        this.last = -Infinity;
    }

    // One lash at `now` (seconds). Returns the combo after it.
    hit(now) {
        this.count = now - this.last <= COMBO_WINDOW ? this.count + 1 : 1;
        this.last = now;
        return {
            count: this.count,
            tier: tierOf(this.count),
            milestone: this.count % MILESTONE_EVERY === 0,
        };
    }

    // Still chaining lashes.
    active(now) {
        return this.count > 0 && now - this.last <= COMBO_WINDOW;
    }

    // Worth showing in the top bar (a combo of 1 is just a lash).
    visible(now) {
        return this.count >= 2 && now - this.last <= COMBO_WINDOW + SHOUT_LINGER;
    }
}
