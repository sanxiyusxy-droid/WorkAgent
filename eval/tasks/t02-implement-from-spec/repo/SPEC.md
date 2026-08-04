# clamp(value, min, max)

Returns `value` restricted to the inclusive range `[min, max]`.

Rules:
- If `value < min`, return `min`.
- If `value > max`, return `max`.
- Otherwise return `value` unchanged.
- `min` is guaranteed to be `<= max`.

The function must be exported via `module.exports = { clamp }`.
