"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEEP_SEARCH_EXPANSION_PROMPT = void 0;
exports.DEEP_SEARCH_EXPANSION_PROMPT = `
[DEEP SEARCH MODE ENABLED]
In addition to normal extraction, for each keyword found, you must generate a list of "expanded_keywords".

Structure the "keywords" field as an array of objects. Each object must contain:
1. "original_keyword": The keyword you extracted.
2. "expanded_keywords": An array of strings containing variations for that specific keyword, including:
   - Hiragana, Katakana, and Kanji variations
   - English translations or common English expressions
   - Abbreviations or formal names (e.g., "UCLA" -> "University of California, Los Angeles")
   - Synonyms or closely related terms

Ensure that "expanded_keywords" are strictly separated and grouped by their respective "original_keyword".

Example Output:
{
  "target": "school",
  "keywords": [
    {
      "original_keyword": "ヨーロッパ",
      "expanded_keywords": [
        "ようろっぱ",
        "Europe",
        "欧州"
      ]
    },
    {
      "original_keyword": "ビジネスメジャー",
      "expanded_keywords": [
        "びじねすめじゃー",
        "business major",
        "経営学専攻",
        "商学専攻",
        "ビジネス専攻"
      ]
    }
  ]
}
`;
