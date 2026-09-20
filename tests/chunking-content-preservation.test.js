import assert from "node:assert/strict";
import test from "node:test";
import { expandForCapture } from "../lib/memory-chunking.js";

for (const [name, text] of Object.entries({
  list: "Die folgenden Angaben sind veraltet:\n- Nein.\n- Die erste lange Aussage gilt nicht mehr.\n- Ja.\n- Die letzte lange Aussage gilt ebenfalls nicht mehr.",
  headings: "Wichtiger Kontext gilt fuer alle Abschnitte.\n# Alpha\nEine lange Aussage.\n# Beta\nEine weitere Aussage.\n# Gamma\nNoch eine Aussage.\n# Delta\nDie letzte Aussage.",
  paragraphs: "Nein.\n\nEine ausreichend lange Aussage.\n\nJa.\n\nEine weitere ausreichend lange Aussage.",
  sentences: "Nein. Erste ausreichend lange Aussage. Ja. Zweite ausreichend lange Aussage. Kurz. Dritte ausreichend lange Aussage. Halt! Letzte ausreichend lange Aussage.",
})) {
  test(`parts-only capture preserves all words and their order: ${name}`, () => {
    const { items, split } = expandForCapture([{ text, it: {}, ok: true }], { keepWhole: false });
    assert.equal(split, 1);
    const words = (value) => value.match(/[\p{L}\p{N}]+/gu);
    assert.deepEqual(words(items.map((item) => item.text).join(" ")), words(text));
  });
}
