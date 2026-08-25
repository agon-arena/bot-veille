// Limite réelle de longueur des titres d'arènes (question de débat, titre
// d'arène libre, question Certamen). Avant le 15/07/2026 les limites (80/90/98
// caractères) n'existaient que dans les prompts, sans application côté code :
// sur les 500 derniers envois, 10 % des titres dépassaient 100 caractères.
// Stratégie : les prompts visent TITLE_TARGET_LENGTH ; au-delà de
// TITLE_HARD_MAX, on demande à l'IA de raccourcir (préserve le sens), et en
// dernier recours on coupe au mot (jamais en plein mot, jamais de "…").

const TITLE_TARGET_LENGTH = 70;
const TITLE_HARD_MAX = 80;

// Mots-outils qui ne doivent jamais terminer un titre coupé ("…dénonce des ?").
const DANGLING_WORDS_END = /(?:\s+(?:le|la|les|l'|un|une|des|du|de|d'|à|au|aux|et|ou|ni|que|qu'|pour|par|avec|sans|sur|dans|sous|vers|entre|chez|contre|face|afin|après|avant|depuis|pendant|selon|dont|où|si|comme|mais|donc|car|puis|lors|dès|plus|moins|très|leur|leurs|se|sa|son|ses|est|sont|a|ont))+$/i;

// Retire ponctuation résiduelle et mots-outils suspendus en fin de titre, en
// préservant le " ?" final d'une question. Appliqué aux coupes ET aux sorties
// de l'IA de raccourcissement, qui laisse parfois un "après" ou un "des" pendu.
function polishTitleEnding(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  const isQuestion = /\?\s*$/.test(value);
  let stem = value
    .replace(/[?？\s]+$/g, "")
    .replace(/[\s,;:.!…«»"'\-–—]+$/g, "")
    .replace(DANGLING_WORDS_END, "")
    .trim();
  if (!stem) return "";
  return isQuestion ? `${stem} ?` : stem;
}

function cutTitleAtWordBoundary(text, max = TITLE_HARD_MAX) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  const isQuestion = /\?\s*$/.test(value);
  const budget = isQuestion ? max - 2 : max;
  let cut = value.slice(0, budget);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > 30) cut = cut.slice(0, lastSpace);
  cut = isQuestion ? `${cut} ?` : cut;
  return polishTitleEnding(cut);
}

const { withAiUsage, featureForLabel } = require("./ai-usage-tracker");

async function enforceTitleLimit(openaiClient, text, options = {}) {
  const {
    max = TITLE_HARD_MAX,
    target = TITLE_TARGET_LENGTH,
    label = "raccourci-titre",
    sourceType
  } = options;

  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;

  if (openaiClient) {
    try {
      const isQuestion = /\?\s*$/.test(value);
      const prompt = `Raccourcis ce titre à ${target} caractères maximum, espaces compris, sans perdre l'information essentielle : garde l'acteur, le fait ou la décision, et le lieu s'il est central.${isQuestion
        ? ` C'est une question de débat : le résultat doit rester une question complète, naturelle, se terminant par " ?".`
        : ` Ce n'est pas une question : le résultat doit rester une phrase affirmative factuelle, sans point final.`}
Ne reformule pas au-delà du nécessaire et n'ajoute aucune information. La phrase raccourcie doit rester grammaticalement correcte. Un fait affirmé reste affirmé : n'introduis pas de conditionnel si l'original n'en contient pas.
Réponds uniquement avec le titre raccourci, sans guillemets ni commentaire.

Titre : ${value}`;
      const response = await withAiUsage(
        { feature: featureForLabel(label), label, sourceType },
        () => openaiClient.responses.create({
          model: "gpt-4o-mini",
          input: prompt,
          temperature: 0.2,
          max_output_tokens: 120
        })
      );
      const shortened = polishTitleEnding(
        String(response.output_text || "")
          .replace(/^["'«\s]+|["'»\s]+$/g, "")
          .replace(/\s+/g, " ")
          .trim()
      );
      if (shortened && shortened.length <= max) {
        console.log(`[titre] Raccourci par IA (${value.length} → ${shortened.length} car.) : "${shortened}"`);
        return shortened;
      }
    } catch (error) {
      console.warn("[titre] Raccourcissement IA impossible :", error.message);
    }
  }

  const cut = cutTitleAtWordBoundary(value, max);
  console.log(`[titre] Coupé au dernier mot entier (${value.length} → ${cut.length} car.) : "${cut}"`);
  return cut;
}

module.exports = { TITLE_TARGET_LENGTH, TITLE_HARD_MAX, cutTitleAtWordBoundary, polishTitleEnding, enforceTitleLimit };
