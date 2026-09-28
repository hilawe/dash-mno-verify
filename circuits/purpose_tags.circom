pragma circom 2.1.6;

// Fixed purpose tags for the two key-derived nullifiers, hashed first in each:
//   single-tier admission:  Poseidon(TAG_SINGLE_TIER_ADMISSION, keyHash, epoch, contextHash)
//   seasonal registration:  Poseidon(TAG_SEASONAL_REGISTRATION, keyHash, season, contextHash)
// Each is hashToField of a labeled string (common/purpose_tags.js, which explains the separation they
// give). test/purpose_tags.test.js checks these literals against that derivation.

// hashToField("dash-mno-verify:purpose:single-tier-admission:v1")
function TAG_SINGLE_TIER_ADMISSION() {
    return 2746475764083232086712230627440145149755258450541734044813292983362430706365;
}

// hashToField("dash-mno-verify:purpose:seasonal-registration:v1")
function TAG_SEASONAL_REGISTRATION() {
    return 4412587802530862675250799606570235507701539531635883910631083162293640935633;
}
