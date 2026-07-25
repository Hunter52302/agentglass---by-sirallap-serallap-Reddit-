# Serrallapa for Argus — provenance and licensing

**Serrallapa for Argus** is a local, experimental merge of two independent
projects. It is not a product, not a release, and not affiliated with or
endorsed by either upstream beyond the licenses below.

## What this is built from

| Component | Origin | Author | License |
|---|---|---|---|
| Everything not listed below | [SirAllap/agentglass](https://github.com/SirAllap/agentglass) | David Pallares (SirAllap) | MIT — see [`LICENSE`](LICENSE) |
| `server/src/argus/**` and the environment-tier UI | [Argus](https://github.com/Hunter52302) | Zac Rieger (Hunter52302) | MIT — see below |

The upstream `LICENSE` file is unmodified and continues to govern all
agentglass code. Nothing in this file narrows, replaces, or adds conditions to
it.

## Why the two were merged

agentglass observes what an agent *reports about itself* — hooks, OTLP spans,
transcripts, tokens, cost. It deliberately never taps the filesystem.

Argus observes the tiers *beneath* that self-report — the OS process table,
the socket table, and filesystem writes — so it can surface activity from
software that reports nothing at all.

The two answer different halves of the same question. This branch explores
carrying Argus in as a clearly separate environment lens, without mixing
unlabeled environment observations into agentglass's labeled agent data.

## License for the Argus-derived portions

MIT License

Copyright (c) 2026 Zac Rieger (Hunter52302)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
