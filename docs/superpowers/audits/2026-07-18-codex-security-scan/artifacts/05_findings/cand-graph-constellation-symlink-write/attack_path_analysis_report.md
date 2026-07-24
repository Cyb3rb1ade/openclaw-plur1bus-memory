# Attack-path analysis — Graph report symlink escape

Candidate: `cand-graph-constellation-symlink-write`  
Affected controls: `lib/memory-graph.js:594-605`, `index.js:4816-4825`.

An Obsidian-vault contributor replaces `memory/graph` with a symlink. A normal graph-report invocation follows it and writes a fixed-date Markdown report outside the vault. The graph hook samples the report at 10%, so timing is a limiter, not a containment control. The vault is a supported user-editable product surface; service privileges and target directory writability remain deployment-dependent. The final decision is **reportable low (P3)**: real filesystem boundary crossing, constrained fixed filename and local-vault prerequisite.
