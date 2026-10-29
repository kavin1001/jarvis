# Siri, Shortcuts and the Action button

Jarvis opens links that start with `jarvis://`, so the iOS Shortcuts app can launch it. No extra setup is needed in the app.

| Link | What it does |
| --- | --- |
| `jarvis://listen` | Opens Jarvis and starts listening. It stops when you stop talking. |
| `jarvis://ask?text=...` | Sends the text and shows the answer |
| `jarvis://ask?text=...&voice=1` | Same, and reads a short answer aloud |
| `jarvis://new` | Starts a new chat |

## "Hey Siri, Jarvis"

1. Open **Shortcuts** and tap **+**.
2. Add **Open URLs** and set the URL to `jarvis://listen`.
3. Rename the shortcut to **Jarvis**.

Now say "Hey Siri, Jarvis" and start talking once the app opens.

## Ask from Siri in one go

1. New shortcut. Add **Dictate Text**.
2. Add **URL Encode** with the **Dictated Text** as input.
3. Add **Open URLs** with `jarvis://ask?voice=1&text=` followed by the **URL Encoded Text** variable.
4. Name it **Ask Jarvis**.

"Hey Siri, Ask Jarvis", say your question, and Jarvis opens and answers out loud.

## Action button (iPhone 15 Pro and later)

Go to Settings, then **Action Button**, then **Shortcut**, and pick the **Jarvis** shortcut above. One press and Jarvis is listening.

## In the app

Tap **Talk** to speak hands-free. Jarvis stops listening when you pause, or you can tap again. You can still hold the button and release it when you're done.
