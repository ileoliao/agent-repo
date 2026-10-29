# Architecture diagrams

| File | What it is |
| --- | --- |
| `component-map.svg` | Component map, standalone SVG source (edit this) |
| `component-map.png` | 2x PNG export of the component map |
| `write-request-sequence.mmd` | Mermaid source: a write request end to end (Outage Console resolving an outage) |
| `write-request-sequence.png` | 2x PNG export of the sequence diagram |
| `architecture.html` | Full engineering page: both diagrams plus headers, identity claims, authorization terms, code map |
| `mermaid-config.json` | Theme used for the sequence export |

Regenerate the PNGs:

```bash
# sequence diagram
mmdc -i write-request-sequence.mmd -o write-request-sequence.png -s 2 -b white -c mermaid-config.json -w 1300

# component map (any SVG rasterizer works; this uses Playwright)
node -e "const {chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1240,height:940},deviceScaleFactor:2});await p.goto('file://'+process.cwd()+'/component-map.svg');await p.screenshot({path:'component-map.png'});await b.close()})();"
```
