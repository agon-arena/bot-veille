function cleanCertamenGeneratedText(text) {
  let value = String(text || "").trim();
  if (!value) return value;

  const replacements = [
    [/\bfaut\s+t['’]?il\b/gi, "faut-il"],
    [/\best\s+t['’]?il\b/gi, "est-il"],
    [/\ba\s+t\s+il\b/gi, "a-t-il"],
    [/\bdoit\s+il\b/gi, "doit-il"],
    [/\bpeut\s+il\b/gi, "peut-il"],
    [/\bdevrait\s+il\b/gi, "devrait-il"],
    [/\bsont\s+ils\b/gi, "sont-ils"],
    [/\bpeuvent\s+ils\b/gi, "peuvent-ils"],
    [/\blextrme\b/gi, "l'extrême"],
    [/\blextrême\b/gi, "l'extrême"],
    [/\bpouvouir\b/gi, "pouvoir"],
    [/\bla\s+gauch\b/gi, "la gauche"],
    [/\bgauch\b/gi, "gauche"],
    [/\becolo\b/gi, "écolo"],
    [/\bdelais\b/gi, "délais"],
    [/\bproteger\b/gi, "protéger"],
    [/\benfant\b(?=[\s?!.,;:]*$)/gi, "enfants"],
    [/\blage legal\b/gi, "l'âge légal"],
    [/\bretraire\b/gi, "retraite"],
    [/\blaissr\b/gi, "laisser"],
    [/\btransparance\b/gi, "transparence"]
  ];

  for (const [pattern, replacement] of replacements) {
    value = value.replace(pattern, replacement);
  }

  return value.replace(/\s+([?!:;])/g, " $1").replace(/\s{2,}/g, " ").trim();
}

module.exports = {
  cleanCertamenGeneratedText
};
