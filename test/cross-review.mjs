import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env から API キーを読み込み
const envPath = path.resolve('D:/ダウンロード/ディスコード/.env');
const envContent = readFileSync(envPath, 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const code = readFileSync(path.resolve(__dirname, '../content.js'), 'utf-8');

const REVIEW_PROMPT = `You are a senior Chrome Extension engineer. Review this content.js for a "Black Hole" Chrome extension that creates a visual black hole effect on web pages.

The extension:
- Detects text characters under the mouse cursor using caretRangeFromPoint
- Makes detected characters transparent (color:transparent) by splitting text nodes and wrapping chars in <span>
- Creates DOM particle clones that are physically simulated being sucked into a black hole
- Images are tiled and absorbed similarly
- On OFF, all DOM changes are restored (spans unwrapped, text nodes normalized)

Review for:
1. Critical bugs (crashes, data loss, DOM corruption)
2. Performance issues (DOM fragmentation, layout thrashing)
3. Edge cases (emoji, RTL text, contenteditable, iframes, Shadow DOM)
4. Memory leaks
5. Race conditions

Format: List issues as CRITICAL/HIGH/MEDIUM/LOW with line references and brief fix suggestions. Be concise. Reply in English.

\`\`\`javascript
${code}
\`\`\``;

async function reviewGemini() {
  console.log('=== Gemini 3.1 Pro Review ===');
  try {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GOOGLE_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: REVIEW_PROMPT }] }],
        generationConfig: { maxOutputTokens: 4000, temperature: 0.3 }
      })
    });
    const data = await resp.json();
    if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
      console.log(data.candidates[0].content.parts[0].text);
    } else {
      console.log('Gemini error:', JSON.stringify(data).slice(0, 500));
    }
  } catch (e) { console.log('Gemini error:', e.message); }
}

async function reviewGPT() {
  console.log('\n=== GPT-4o Review ===');
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: REVIEW_PROMPT }],
        max_tokens: 4000,
        temperature: 0.3
      })
    });
    const data = await resp.json();
    if (data.choices?.[0]?.message?.content) {
      console.log(data.choices[0].message.content);
    } else {
      console.log('GPT error:', JSON.stringify(data).slice(0, 500));
    }
  } catch (e) { console.log('GPT error:', e.message); }
}

await Promise.all([reviewGemini(), reviewGPT()]);
