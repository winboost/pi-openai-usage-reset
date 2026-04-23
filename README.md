# OpenAI Usage Reset

Pi extension that shows OpenAI Codex quota info as a small extra footer status.

Example status line:

```text
◷ OpenAI Usage: 5h 5:59 AM · 7d 74% left
```

## Behavior

- It only appears for `openai-codex` models.
- It does **not** replace pi's built-in footer.
- It does **not** make a startup probe request.
- The 5h reset time comes from normal OpenAI response headers.
- The 7d quota is fetched lazily from OpenAI only after a real `openai-codex` response, and refreshed again on each subsequent real `openai-codex` response.
- Before the first real response, it shows:
  - `◷ OpenAI Usage: 5h [after first response]`
- While the 7d quota is being fetched, it shows:
  - `◷ OpenAI Usage: 5h 5:59 AM · 7d [fetching…]`
- If 7d quota data is unavailable (for example auth missing/expired), it simply keeps showing the 5h status.

## Install

Copy `openai-usage-reset.js` directly into one of these locations:

- `~/.pi/agent/extensions/openai-usage-reset.js`
- `.pi/extensions/openai-usage-reset.js`

Then run `/reload` in pi.

If you already copied the old `.ts` version, replace it with the `.js` file instead of keeping both.
