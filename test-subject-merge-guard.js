// Garde-fou des fusions de la déduplication IA (subject-merge-guard.js), sur le cas réel de la
// session veille mixte du 02/11/2026 : l'IA avait mis dans le groupe midterms la vidéo
// Révolution permanente sur les militants du 31 octobre, l'Iran et la caricature de Mohammed VI.
// Exécution : node --test test-subject-merge-guard.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const { filterIncoherentMergeSubjects } = require('./subject-merge-guard');

const source = fs.readFileSync(require.resolve('./veille-mixte.js'), 'utf8');
function appFunction(name, next, context) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(next, start);
  return vm.runInNewContext(source.slice(start, end) + `\n${name}`, context);
}
const cleanText = appFunction('cleanText', 'const HTML_NAMED_ENTITIES', {});
const getKeywords = appFunction('getKeywords', 'function countSharedKeywords', { cleanText });

const subject = (subjectId, ...titles) => ({
  subjectId, subject: titles[0], contents: titles.map((title, i) => ({ title, source: `S${i}`, link: `${subjectId}-${i}` }))
});

const midterms = subject('subject_007',
  'Midterms 2026 : les reniements de Donald Trump l’exposent à un vote sanction de la part des électeurs américains',
  'Donald Trump est-il condamné à perdre les midterms 2026 ? Ce que confirment (ou pas) les élections passées',
  'Midterms aux États-Unis : à quoi s\'attendre le 3 novembre ?');
const legit = [
  subject('subject_018', 'Midterms aux États-Unis : "Trump a décidé d\'en faire un référendum"'),
  subject('subject_143', 'Midterms : déçu par Trump et essoré par l’inflation, le Texas conservateur pourrait élire un sénateur démocrate'),
  // Aucun mot en commun avec le sujet principal, mais « Michigan » le relie au sujet précédent
  // une fois celui-ci accepté (chaîne de formulations).
  subject('subject_146', 'Midterms : dans le Michigan, la course avec Abdul El-Sayed connaît un retournement de situation spectaculaire',
    'Midterms 2026: dans le Michigan, l\'unité des démocrates mise à mal par un spot publicitaire jugé antisémite')
];
const offTopic = [
  subject('subject_087', '31 octobre : comment les autorités ont détourné des outils antiterroristes pour assigner des militants à domicile',
    '31 octobre : l’Etat utilise des mesures anti-terroristes pour assigner des militants à résidence'),
  subject('subject_091', 'L’Iran met en garde les États-Unis contre une reprise des hostilités',
    'Entre les États-Unis et l\'Iran, «le ton a changé», estime le chercheur Thierry Coville'),
  subject('subject_157', 'Maroc : Un jeune dessinateur condamné à quatre ans de prison pour une caricature du roi Mohammed VI',
    '«Une insulte à l\'encontre du roi» : la justice condamne l\'auteur de caricatures de Mohammed VI')
];

test('le groupe midterms garde ses vrais sujets et écarte les hors-sujet', () => {
  const { accepted, rejected } = filterIncoherentMergeSubjects(midterms, [...offTopic, ...legit], getKeywords);
  assert.deepEqual(accepted.map((s) => s.subjectId), ['subject_018', 'subject_143', 'subject_146']);
  assert.deepEqual(rejected.map((s) => s.subjectId), ['subject_087', 'subject_091', 'subject_157']);
});

test('un même fait formulé différemment reste fusionné grâce à un nom propre partagé', () => {
  const binance = subject('subject_078', 'Cyberattaque contre Binance : FBI accuse la Corée du Nord', 'Le FBI accuse la Corée du Nord du "casse du siècle" chez Binance');
  const other = subject('subject_188', 'Binance : 6 milliards de dollars en crypto envolés en 20 minutes, le récit du casse du siècle');
  assert.equal(filterIncoherentMergeSubjects(binance, [other], getKeywords).rejected.length, 0);
});

test('applySubjectMergeGroups ne fusionne pas les sujets écartés et les laisse séparés', () => {
  const mergeSubjectRecords = (keep, merged) => ({ ...keep, contents: [keep, ...merged].flatMap((s) => s.contents), mergedIds: merged.map((s) => s.subjectId) });
  const apply = appFunction('applySubjectMergeGroups', 'async function deduplicateSubjectsWithAI', {
    ensureSubjectIds: (subjects) => subjects, mergeSubjectRecords, filterIncoherentMergeSubjects, getKeywords,
    console: { warn: () => {} }
  });
  // Aller-retour JSON : les tableaux créés dans le contexte vm ne sont pas du même realm.
  const result = JSON.parse(JSON.stringify(apply([midterms, ...legit, ...offTopic], { mergeGroups: [{
    keepSubjectId: 'subject_007',
    mergeSubjectIds: [...legit, ...offTopic].map((s) => s.subjectId),
    confidence: 0.9
  }] })));
  const merged = result.subjects.find((s) => s.subjectId === 'subject_007');
  assert.deepEqual(merged.mergedIds, ['subject_018', 'subject_143', 'subject_146']);
  assert.ok(!merged.contents.some((c) => /militants|Iran|Mohammed/.test(c.title)));
  assert.deepEqual(result.subjects.filter((s) => s.subjectId !== 'subject_007').map((s) => s.subjectId).sort(), ['subject_087', 'subject_091', 'subject_157']);
  assert.deepEqual(result.appliedGroups[0].rejectedSubjectIds, ['subject_087', 'subject_091', 'subject_157']);
});
