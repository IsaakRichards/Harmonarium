// Censor: swear words and slurs in a book's text become asterisks ("shit" → "****").
// Each word keeps its length, so bookmarks, quotes and search jumps (which count characters)
// land where they always did, and turning the censor off brings the words straight back.
//
// The list is matched against whole words, without regard to case. Edit it freely: each entry is
// a regular expression for one whole word (no ^ or $ needed).

const WORDS = [
  // the strongest roots, wherever they appear in a word (motherfucker, bullshit, dipshit…)
  "\\w*fuck\\w*", "\\w*phuck\\w*", "\\w*shit\\w*", "\\w*cunt\\w*",
  "bitch\\w*", "\\w*cocksuck\\w*", "dickheads?", "\\w*twats?", "wank\\w*",
  "(?:dumb|jack|smart|bad|kick|hard|lard|fat|wise|kiss|candy|half)?ass(?:es)?",
  "ass(?:hole|holes|hat|hats|wipe|wipes|clown|clowns|face|kisser|kissing)", "arse(?:s|hole|holes)?",
  "bastards?", "(?:god)?damn(?:ed|it|s)?", "goddam", "dammit",
  "piss(?:ed|es|ing|er|ers)?", "bollocks", "douche(?:s|bag|bags)?",
  "whores?", "sluts?", "slutty", "skank\\w*",
  // slurs
  "nigg(?:er|ers|a|as|az)", "faggots?", "retard(?:s|ed)?", "spics?",
  "kikes?", "trann(?:y|ies)", "wetbacks?",
];

// Ordinary words the patterns above would otherwise catch. Words with an everyday meaning too
// (pussy cat, chinks in armour, a dyke on the coast, a fag in Britain) are left off the list.
const ALLOWED = new Set([
  "scunthorpe", "shittim", "shitake", "shiitake", "cocksure", "cocksfoot",
]);

const MATCH = new RegExp(`^(?:${WORDS.join("|")})$`, "i");
// A word is a run of letters; apostrophes and hyphens split it ("son-of-a-bitch" → only "bitch").
const WORD = /\p{L}+/gu;

const stars = (w) => "*".repeat(w.length);
const bad = (w) => MATCH.test(w) && !ALLOWED.has(w.toLowerCase());

/** The text with every censored word turned into asterisks of the same length. */
export function censorText(text) {
  if (!text) return text;
  return String(text).replace(WORD, (w) => (bad(w) ? stars(w) : w));
}

const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "svg", "math"]);

/** Censor a chapter's document in place, text node by text node, before it is shown.
 *  Words split across inline elements ("sh<i>it</i>") are rare enough to leave alone. */
export function censorDoc(doc) {
  const body = doc?.body;
  if (!body) return;
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (SKIP.has(n.parentNode?.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const v = n.nodeValue;
    if (!v || !/\p{L}{3}/u.test(v)) continue;
    const out = censorText(v);
    if (out !== v) n.nodeValue = out;
  }
  // Image descriptions and link tooltips can carry words too.
  for (const el of body.querySelectorAll("[alt], [title]")) {
    for (const a of ["alt", "title"]) {
      const v = el.getAttribute(a);
      if (v) { const out = censorText(v); if (out !== v) el.setAttribute(a, out); }
    }
  }
}
