# tokens.js API

Implement and export two functions via `module.exports = { tokenize, countTokens }`.

## tokenize(text)
Splits `text` into words. A word is a maximal run of non-whitespace
characters. Returns an array of words. Empty or whitespace-only input
returns an empty array.

## countTokens(text)
Returns the number of words `tokenize(text)` would produce.
