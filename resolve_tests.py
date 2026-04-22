import re

with open('artifacts/api-server/src/lib/engines/avri/handwavy-phrases.test.ts', 'r') as f:
    content = f.read()

pattern = re.compile(r'<<<<<<< HEAD(.*?)=======([\s\S]*?)>>>>>>> 3c8d7ea \(Task #120: in-place edits for curated FLAT hand-wavy marker phrases\)', re.DOTALL)

def replacer(match):
    return match.group(1) + match.group(2)

new_content = pattern.sub(replacer, content)

with open('artifacts/api-server/src/lib/engines/avri/handwavy-phrases.test.ts', 'w') as f:
    f.write(new_content)
