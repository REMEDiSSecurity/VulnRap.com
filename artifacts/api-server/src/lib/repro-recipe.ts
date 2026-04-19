import type { VerificationResult } from "./active-verification";
import type { LLMTriageGuidance } from "./triage-assistant";

export interface TargetProject {
  name: string;
  version: string | null;
  source: string | null;
  language: string | null;
  packageManager: string | null;
}

export interface ReproRecipe {
  title: string;
  target: TargetProject | null;
  setupCommands: string[];
  pocScript: string | null;
  pocLanguage: string | null;
  expectedOutput: string | null;
  dockerfile: string | null;
  notes: string[];
  hardware: HardwareComponent[];
}

const GITHUB_REPO_RE = /https?:\/\/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/gi;
const GITLAB_REPO_RE = /https?:\/\/gitlab\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/gi;

const VERSION_RE = /\b(?:v(?:ersion)?\.?\s*)?(\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.]+)?)\b/gi;
const SEMVER_STRICT_RE = /\b(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)\b/g;

const NPM_INSTALL_RE = /(?:npm\s+install|yarn\s+add|pnpm\s+(?:add|install))\s+([^\s;&|]+)/gi;
const PIP_INSTALL_RE = /(?:pip3?\s+install)\s+([^\s;&|]+)/gi;
const GEM_INSTALL_RE = /gem\s+install\s+([^\s;&|]+)/gi;

const CURL_CMD_RE = /curl\s+(?:[^\n;|&]|\\[\n])+/gi;
const PYTHON_BLOCK_RE = /```python\s*\n([\s\S]*?)```/gi;
const BASH_BLOCK_RE = /```(?:bash|sh|shell|zsh)\s*\n([\s\S]*?)```/gi;
const CODE_BLOCK_RE = /```(\w*)\s*\n([\s\S]*?)```/gi;
const HTTP_REQUEST_RE = /(?:GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+(?:https?:\/\/[^\s]+|\/[^\s]*)/gi;

export interface HardwareComponent {
  type: "cpu" | "server" | "network" | "iot" | "storage" | "peripheral" | "embedded" | "gpu";
  vendor: string;
  model: string | null;
  productUrl: string | null;
  emulationOptions: string[];
  notes: string[];
}

interface HardwarePattern {
  type: HardwareComponent["type"];
  vendor: string;
  pattern: RegExp;
  modelExtract?: RegExp;
  productUrlTemplate?: string;
  emulationOptions: string[];
}

const HARDWARE_PATTERNS: HardwarePattern[] = [
  {
    type: "cpu", vendor: "Intel",
    pattern: /\b(?:intel\s+)?(?:core\s+i[3579]|xeon|celeron|pentium|atom|alder\s*lake|raptor\s*lake|sapphire\s*rapids|ice\s*lake|tiger\s*lake|meteor\s*lake)\b/i,
    modelExtract: /\b((?:Core\s+i[3579]|Xeon|Celeron|Pentium|Atom)[\w\s-]{0,30})/i,
    productUrlTemplate: "https://ark.intel.com/content/www/us/en/ark/search.html?q=",
    emulationOptions: [
      "QEMU with -cpu host or specific CPU model flag",
      "Intel SDE (Software Development Emulator) for instruction set emulation",
      "VirtualBox/VMware with CPU feature passthrough"
    ],
  },
  {
    type: "cpu", vendor: "AMD",
    pattern: /\b(?:amd\s+)?(?:ryzen|epyc|threadripper|athlon|opteron|zen\s*[234]?)\b/i,
    modelExtract: /\b((?:Ryzen|EPYC|Threadripper|Athlon|Opteron)[\w\s-]{0,30})/i,
    productUrlTemplate: "https://www.amd.com/en/search.html#q=",
    emulationOptions: [
      "QEMU with specific AMD CPU model emulation",
      "VirtualBox/VMware with nested virtualization for AMD-V testing"
    ],
  },
  {
    type: "cpu", vendor: "ARM",
    pattern: /\b(?:arm\s+)?(?:cortex[-\s]?[amr]\d+|aarch64|armv[78]|neoverse|arm64|apple\s+m[1234])\b/i,
    modelExtract: /\b((?:Cortex[-\s]?[AMR]\d+|Neoverse[\w\s-]{0,20}|Apple\s+M\d))/i,
    emulationOptions: [
      "QEMU aarch64 system emulation: qemu-system-aarch64",
      "QEMU user-mode emulation for running ARM binaries on x86",
      "Docker with --platform linux/arm64 for container-based testing",
      "Raspberry Pi or similar ARM dev board for native testing"
    ],
  },
  {
    type: "server", vendor: "Dell",
    pattern: /\b(?:dell\s+)?(?:poweredge|idrac|dell\s+emc|openmanage|wyse|optiplex|latitude|precision|vostro|inspiron)\b/i,
    modelExtract: /\b((?:PowerEdge|iDRAC|OptiPlex|Latitude|Precision|Wyse)[\w\s-]{0,30})/i,
    productUrlTemplate: "https://www.dell.com/support/home/en-us/product-support/product/",
    emulationOptions: [
      "iDRAC simulator (Dell's virtual iDRAC for testing management interfaces)",
      "OpenManage virtual appliance for Dell systems management testing",
      "IPMI emulation via ipmi_sim for BMC testing"
    ],
  },
  {
    type: "server", vendor: "HPE",
    pattern: /\b(?:hpe?\s+)?(?:proliant|ilo|superdome|moonshot|edgeline|simplivity|nimble|primera)\b/i,
    modelExtract: /\b((?:ProLiant|iLO|Superdome|Moonshot|Edgeline)[\w\s-]{0,30})/i,
    productUrlTemplate: "https://www.hpe.com/us/en/search-results.html?q=",
    emulationOptions: [
      "HPE iLO simulator for management interface testing",
      "IPMI emulation for BMC vulnerability testing"
    ],
  },
  {
    type: "server", vendor: "Lenovo",
    pattern: /\b(?:lenovo\s+)?(?:thinkserver|thinksystem|xclarity|thinkagile|thinkedge)\b/i,
    modelExtract: /\b((?:ThinkServer|ThinkSystem|XClarity|ThinkAgile|ThinkEdge)[\w\s-]{0,30})/i,
    productUrlTemplate: "https://support.lenovo.com/us/en/search?query=",
    emulationOptions: ["IPMI emulation via ipmi_sim", "XClarity virtual appliance"],
  },
  {
    type: "network", vendor: "Cisco",
    pattern: /\b(?:cisco\s+)?(?:ios[-\s]?xe?|nx-os|asa|firepower|catalyst|nexus|meraki|webex|aironet|csr\s*1000|isr\s*[1-4])\b/i,
    modelExtract: /\b((?:Catalyst|Nexus|ASA|Firepower|Meraki|Aironet|CSR|ISR)[\w\s-]{0,30})/i,
    productUrlTemplate: "https://www.cisco.com/c/en/us/products/index.html#~q=",
    emulationOptions: [
      "GNS3 with Cisco IOS/IOS-XE images for network device emulation",
      "Cisco CML (Modeling Labs) for full network topology simulation",
      "EVE-NG with Cisco images for multi-device lab environments",
      "Cisco DevNet Sandbox for free cloud-hosted lab access"
    ],
  },
  {
    type: "network", vendor: "Juniper",
    pattern: /\b(?:juniper\s+)?(?:junos|srx|mx\s*\d+|ex\s*\d+|qfx|contrail|mist)\b/i,
    modelExtract: /\b((?:SRX|MX|EX|QFX)[\w\s-]{0,20})/i,
    productUrlTemplate: "https://www.juniper.net/search/#q=",
    emulationOptions: [
      "Juniper vSRX virtual firewall for security testing",
      "GNS3/EVE-NG with JunOS images",
      "Juniper vLabs for cloud-hosted lab access"
    ],
  },
  {
    type: "network", vendor: "Fortinet",
    pattern: /\b(?:fortinet\s+)?(?:fortigate|fortios|fortimanager|fortianalyzer|fortiweb|fortimail|fortisandbox)\b/i,
    modelExtract: /\b((?:FortiGate|FortiOS|FortiManager|FortiAnalyzer|FortiWeb)[\w\s-]{0,30})/i,
    productUrlTemplate: "https://www.fortinet.com/search?q=",
    emulationOptions: [
      "FortiGate VM trial license for virtual appliance testing",
      "GNS3/EVE-NG with FortiGate VM images"
    ],
  },
  {
    type: "network", vendor: "Palo Alto",
    pattern: /\b(?:palo\s*alto\s+)?(?:pan-os|pa-\d+|panorama|globalprotect|prisma|cortex\s+xdr|wildfire)\b/i,
    modelExtract: /\b((?:PA-\d+|PAN-OS|Panorama|GlobalProtect|Prisma)[\w\s-]{0,30})/i,
    productUrlTemplate: "https://www.paloaltonetworks.com/search#q=",
    emulationOptions: [
      "PAN-OS VM-Series evaluation license for virtual firewall testing",
      "GNS3/EVE-NG with PA-VM images"
    ],
  },
  {
    type: "iot", vendor: "Generic IoT",
    pattern: /\b(?:mqtt|coap|zigbee|z-wave|bluetooth\s*le|ble|lorawan|modbus|bacnet|opc[-\s]?ua|scada|plc|hmi|dcs|rtu)\b/i,
    emulationOptions: [
      "Eclipse Mosquitto for MQTT broker emulation",
      "Firmadyne for firmware emulation and dynamic analysis",
      "QEMU for embedded Linux firmware emulation",
      "GRFICSv2 for SCADA/ICS simulation environments",
      "OpenPLC for PLC emulation and ladder logic testing"
    ],
  },
  {
    type: "iot", vendor: "Raspberry Pi",
    pattern: /\b(?:raspberry\s*pi|rpi|raspbian|raspberry\s*pi\s*(?:zero|pico|[2345]))\b/i,
    modelExtract: /\b(Raspberry\s*Pi[\w\s]*?\d?)/i,
    productUrlTemplate: "https://www.raspberrypi.com/products/",
    emulationOptions: [
      "QEMU Raspberry Pi emulation (raspi2/raspi3 machine type)",
      "Docker with ARM emulation via binfmt_misc + qemu-user-static"
    ],
  },
  {
    type: "embedded", vendor: "Firmware",
    pattern: /\b(?:firmware|uefi|bios|bootloader|u-boot|grub|secure\s*boot|tpm|trusted\s*platform|sgx|trustzone|tee)\b/i,
    emulationOptions: [
      "QEMU with OVMF for UEFI firmware emulation",
      "Firmwalker/Binwalk for firmware extraction and analysis",
      "Unicorn Engine for CPU emulation of firmware code",
      "swtpm for TPM emulation",
      "Intel SGX SDK with simulation mode for SGX enclave testing"
    ],
  },
  {
    type: "storage", vendor: "NAS/SAN",
    pattern: /\b(?:synology|qnap|netapp|truenas|freenas|iscsi|fibre\s*channel|san\s+switch|nas\s+device|drobo|buffalo\s+nas)\b/i,
    modelExtract: /\b((?:Synology|QNAP|NetApp|TrueNAS|FreeNAS)[\w\s-]{0,30})/i,
    emulationOptions: [
      "TrueNAS CORE/SCALE VM for NAS testing",
      "Synology Virtual DSM for Synology-specific testing",
      "VirtualBox/VMware with NAS OS ISOs"
    ],
  },
  {
    type: "gpu", vendor: "NVIDIA",
    pattern: /\b(?:nvidia\s+)?(?:cuda|geforce|rtx\s*\d+|gtx\s*\d+|tesla|a100|h100|quadro|jetson|dgx)\b/i,
    modelExtract: /\b((?:RTX|GTX|Tesla|A100|H100|Quadro|Jetson|DGX)[\w\s-]{0,20})/i,
    productUrlTemplate: "https://www.nvidia.com/en-us/search/?q=",
    emulationOptions: [
      "NVIDIA GPU Cloud (NGC) containers for GPU workload testing",
      "CUDA toolkit with CPU fallback mode for basic testing without GPU",
      "Cloud GPU instances (AWS p3/p4, GCP A2/A3) for real hardware access"
    ],
  },
];

function detectHardwareComponents(text: string): HardwareComponent[] {
  const components: HardwareComponent[] = [];
  const seen = new Set<string>();

  for (const hp of HARDWARE_PATTERNS) {
    if (!hp.pattern.test(text)) continue;

    let model: string | null = null;
    if (hp.modelExtract) {
      const modelMatch = text.match(hp.modelExtract);
      if (modelMatch) model = modelMatch[1].trim();
    }

    const key = `${hp.vendor}-${hp.type}-${model || "generic"}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let productUrl: string | null = null;
    if (hp.productUrlTemplate && model) {
      productUrl = hp.productUrlTemplate + encodeURIComponent(model);
    }

    const notes: string[] = [];
    if (model) {
      notes.push(`Detected reference to ${hp.vendor} ${model}`);
    } else {
      notes.push(`Detected reference to ${hp.vendor} ${hp.type} technology`);
    }

    components.push({
      type: hp.type,
      vendor: hp.vendor,
      model,
      productUrl,
      emulationOptions: hp.emulationOptions,
      notes,
    });
  }

  return components;
}

const LANG_SIGNALS: Array<{ lang: string; pm: string; patterns: RegExp[] }> = [
  { lang: "JavaScript/Node.js", pm: "npm", patterns: [/\bnode(?:\.js)?\b/i, /\bnpm\b/i, /\byarn\b/i, /\bpackage\.json\b/i, /\brequire\s*\(/i, /\bconst\s+\w+\s*=\s*require\b/i] },
  { lang: "Python", pm: "pip", patterns: [/\bpython3?\b/i, /\bpip3?\b/i, /\bimport\s+\w+/i, /\brequirements\.txt\b/i, /\bflask\b/i, /\bdjango\b/i] },
  { lang: "Java", pm: "maven", patterns: [/\bjava\b/i, /\bmaven\b/i, /\bgradle\b/i, /\bpom\.xml\b/i, /\b\.jar\b/i] },
  { lang: "PHP", pm: "composer", patterns: [/\bphp\b/i, /\bcomposer\b/i, /\b<\?php\b/i, /\blaravel\b/i] },
  { lang: "Ruby", pm: "gem", patterns: [/\bruby\b/i, /\bgem\b/i, /\brails\b/i, /\bGemfile\b/i] },
  { lang: "Go", pm: "go", patterns: [/\bgo(?:lang)?\b/i, /\bgo\.mod\b/i, /\bfunc\s+\w+\s*\(/i] },
  { lang: "Rust", pm: "cargo", patterns: [/\brust\b/i, /\bcargo\b/i, /\bCargo\.toml\b/i] },
  { lang: "C/C++", pm: "make", patterns: [/\b(?:gcc|g\+\+|clang|make|cmake)\b/i, /\b#include\s*</i, /\bMakefile\b/i, /\bbuffer\s*overflow\b/i] },
];

function extractRepoUrls(text: string): string[] {
  const repos = new Set<string>();
  for (const match of text.matchAll(GITHUB_REPO_RE)) {
    const cleaned = match[1].replace(/\.git$/, "").replace(/\/+$/, "");
    repos.add(`https://github.com/${cleaned}`);
  }
  for (const match of text.matchAll(GITLAB_REPO_RE)) {
    const cleaned = match[1].replace(/\.git$/, "").replace(/\/+$/, "");
    repos.add(`https://gitlab.com/${cleaned}`);
  }
  return [...repos];
}

function extractVersions(text: string): string[] {
  const versions = new Set<string>();
  for (const match of text.matchAll(SEMVER_STRICT_RE)) {
    versions.add(match[1]);
  }
  if (versions.size === 0) {
    for (const match of text.matchAll(VERSION_RE)) {
      versions.add(match[1]);
    }
  }
  return [...versions].slice(0, 5);
}

function detectLanguage(text: string): { lang: string; pm: string } | null {
  let best: { lang: string; pm: string; score: number } | null = null;
  for (const sig of LANG_SIGNALS) {
    let score = 0;
    for (const p of sig.patterns) {
      if (p.test(text)) score++;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { ...sig, score };
    }
  }
  return best ? { lang: best.lang, pm: best.pm } : null;
}

function extractPocCommands(text: string): { script: string; language: string } | null {
  const pythonBlocks: string[] = [];
  for (const m of text.matchAll(PYTHON_BLOCK_RE)) {
    pythonBlocks.push(m[1].trim());
  }
  if (pythonBlocks.length > 0) {
    return { script: pythonBlocks.join("\n\n"), language: "python" };
  }

  const bashBlocks: string[] = [];
  for (const m of text.matchAll(BASH_BLOCK_RE)) {
    bashBlocks.push(m[1].trim());
  }
  if (bashBlocks.length > 0) {
    return { script: bashBlocks.join("\n\n"), language: "bash" };
  }

  const curlCmds: string[] = [];
  for (const m of text.matchAll(CURL_CMD_RE)) {
    curlCmds.push(m[0].trim());
  }
  if (curlCmds.length > 0) {
    return { script: curlCmds.join("\n\n"), language: "bash" };
  }

  const httpReqs: string[] = [];
  for (const m of text.matchAll(HTTP_REQUEST_RE)) {
    httpReqs.push(m[0].trim());
  }
  if (httpReqs.length > 0) {
    return { script: httpReqs.map(r => `# ${r}`).join("\n"), language: "http" };
  }

  const genericBlocks: Array<{ lang: string; code: string }> = [];
  for (const m of text.matchAll(CODE_BLOCK_RE)) {
    if (m[2].trim().length > 10) {
      genericBlocks.push({ lang: m[1] || "text", code: m[2].trim() });
    }
  }
  if (genericBlocks.length > 0) {
    const first = genericBlocks[0];
    return { script: genericBlocks.map(b => b.code).join("\n\n"), language: first.lang };
  }

  return null;
}

function extractPackageInstalls(text: string): string[] {
  const installs: string[] = [];
  for (const m of text.matchAll(NPM_INSTALL_RE)) installs.push(m[0].trim());
  for (const m of text.matchAll(PIP_INSTALL_RE)) installs.push(m[0].trim());
  for (const m of text.matchAll(GEM_INSTALL_RE)) installs.push(m[0].trim());
  return installs;
}

function buildSetupCommands(
  repoUrl: string | null,
  version: string | null,
  langInfo: { lang: string; pm: string } | null,
  packageInstalls: string[],
): string[] {
  const cmds: string[] = [];

  if (repoUrl) {
    cmds.push(`git clone ${repoUrl}`);
    const repoName = repoUrl.split("/").pop() || "project";
    cmds.push(`cd ${repoName}`);
    if (version) {
      cmds.push(`git checkout v${version} 2>/dev/null || git checkout ${version} 2>/dev/null || echo "Version tag not found, using latest"`);
    }
  }

  if (langInfo) {
    switch (langInfo.pm) {
      case "npm":
        cmds.push("npm install");
        break;
      case "pip":
        cmds.push("python3 -m venv venv && source venv/bin/activate");
        cmds.push("pip install -r requirements.txt 2>/dev/null || echo 'No requirements.txt found'");
        break;
      case "composer":
        cmds.push("composer install");
        break;
      case "gem":
        cmds.push("bundle install");
        break;
      case "go":
        cmds.push("go mod download");
        break;
      case "cargo":
        cmds.push("cargo build");
        break;
      case "maven":
        cmds.push("mvn install -DskipTests");
        break;
      case "make":
        cmds.push("make 2>/dev/null || cmake . && make");
        break;
    }
  }

  for (const install of packageInstalls) {
    if (!cmds.some(c => c.includes(install))) {
      cmds.push(install);
    }
  }

  return cmds;
}

function buildDockerfile(
  repoUrl: string | null,
  version: string | null,
  langInfo: { lang: string; pm: string } | null,
): string | null {
  if (!repoUrl && !langInfo) return null;

  const lines: string[] = [];

  let baseImage = "ubuntu:22.04";
  const installPkgs: string[] = ["git", "curl"];

  if (langInfo) {
    switch (langInfo.pm) {
      case "npm":
        baseImage = "node:20-slim";
        break;
      case "pip":
        baseImage = "python:3.12-slim";
        break;
      case "go":
        baseImage = "golang:1.22-bookworm";
        break;
      case "cargo":
        baseImage = "rust:1.77-slim-bookworm";
        break;
      case "maven":
        baseImage = "maven:3.9-eclipse-temurin-21";
        break;
      case "composer":
        baseImage = "php:8.3-cli";
        installPkgs.push("unzip");
        break;
      case "gem":
        baseImage = "ruby:3.3-slim";
        break;
      case "make":
        installPkgs.push("build-essential", "cmake");
        break;
    }
  }

  lines.push(`FROM ${baseImage}`);
  if (installPkgs.length > 0 && !["node:20-slim", "python:3.12-slim", "golang:1.22-bookworm", "rust:1.77-slim-bookworm"].includes(baseImage)) {
    lines.push(`RUN apt-get update && apt-get install -y ${installPkgs.join(" ")} && rm -rf /var/lib/apt/lists/*`);
  }
  lines.push("WORKDIR /app");

  if (repoUrl) {
    lines.push(`RUN git clone ${repoUrl} .`);
    if (version) {
      lines.push(`RUN git checkout v${version} 2>/dev/null || git checkout ${version} || true`);
    }
  } else {
    lines.push("COPY . .");
  }

  if (langInfo) {
    switch (langInfo.pm) {
      case "npm":
        lines.push("RUN npm install");
        break;
      case "pip":
        lines.push("RUN pip install -r requirements.txt 2>/dev/null || true");
        break;
      case "composer":
        lines.push("RUN composer install --no-dev");
        break;
      case "gem":
        lines.push("RUN bundle install");
        break;
      case "go":
        lines.push("RUN go build ./...");
        break;
      case "cargo":
        lines.push("RUN cargo build");
        break;
      case "maven":
        lines.push("RUN mvn package -DskipTests");
        break;
      case "make":
        lines.push("RUN make 2>/dev/null || (cmake . && make)");
        break;
    }
  }

  lines.push('CMD ["bash"]');

  return lines.join("\n");
}

export function generateReproRecipe(
  text: string,
  verification: VerificationResult | null,
  llmTriageGuidance: LLMTriageGuidance | null,
): ReproRecipe | null {
  const repoUrls = extractRepoUrls(text);
  const versions = extractVersions(text);
  const langInfo = detectLanguage(text);
  const poc = extractPocCommands(text);
  const packageInstalls = extractPackageInstalls(text);
  const hardwareComponents = detectHardwareComponents(text);

  const primaryRepo = repoUrls[0] || null;
  const primaryVersion = versions[0] || null;

  const hasSubstance = primaryRepo || poc || packageInstalls.length > 0 ||
    hardwareComponents.length > 0 ||
    (llmTriageGuidance?.reproSteps?.length ?? 0) > 0 ||
    (llmTriageGuidance?.environment?.length ?? 0) > 0;

  if (!hasSubstance) return null;

  const target: TargetProject | null = primaryRepo ? {
    name: primaryRepo.split("/").slice(-2).join("/"),
    version: primaryVersion,
    source: primaryRepo,
    language: langInfo?.lang || null,
    packageManager: langInfo?.pm || null,
  } : langInfo ? {
    name: "target application",
    version: primaryVersion,
    source: null,
    language: langInfo.lang,
    packageManager: langInfo.pm,
  } : null;

  const setupCommands = buildSetupCommands(primaryRepo, primaryVersion, langInfo, packageInstalls);

  if (llmTriageGuidance?.environment) {
    for (const env of llmTriageGuidance.environment) {
      const envLower = env.toLowerCase();
      if (envLower.includes("install") || envLower.includes("setup") || envLower.includes("configure")) {
        const asCmd = env.replace(/^(?:install|set up|configure)\s*/i, "").trim();
        if (asCmd.length > 3 && !setupCommands.some(c => c.toLowerCase().includes(asCmd.toLowerCase()))) {
          setupCommands.push(`# ${env}`);
        }
      }
    }
  }

  const dockerfile = buildDockerfile(primaryRepo, primaryVersion, langInfo);

  const notes: string[] = [];

  if (verification) {
    const verified = verification.checks.filter(c => c.result === "verified");
    const notFound = verification.checks.filter(c => c.result === "not_found");

    if (verified.length > 0) {
      notes.push(`${verified.length} reference(s) verified against live sources (${verified.map(c => c.target).join(", ")})`);
    }
    if (notFound.length > 0) {
      notes.push(`WARNING: ${notFound.length} reference(s) not found — ${notFound.map(c => `${c.target}: ${c.detail || "not found"}`).join("; ")}`);
    }
  }

  if (!primaryRepo) {
    notes.push("No repository URL detected in report — you may need to identify the target project manually.");
  }
  if (!primaryVersion) {
    notes.push("No specific version detected — check with the reporter which version was tested.");
  }
  if (!poc) {
    notes.push("No runnable PoC commands extracted — the report may describe the issue without executable steps.");
  }

  for (const hw of hardwareComponents) {
    if (hw.productUrl) {
      notes.push(`${hw.vendor} ${hw.model || hw.type}: product info at ${hw.productUrl}`);
    }
    if (hw.emulationOptions.length > 0) {
      notes.push(`Emulation for ${hw.vendor} ${hw.model || hw.type}: ${hw.emulationOptions[0]}`);
    }
    if (hw.type === "iot" || hw.type === "embedded") {
      notes.push("Hardware-dependent vulnerability — consider using firmware emulation (Firmadyne/QEMU) if physical device is unavailable.");
    }
    if (hw.type === "network") {
      notes.push("Network device vulnerability — consider GNS3/EVE-NG lab or vendor's virtual appliance for testing.");
    }
  }

  let expectedOutput: string | null = null;
  if (llmTriageGuidance?.expectedBehavior) {
    expectedOutput = llmTriageGuidance.expectedBehavior;
  }

  const projectLabel = target?.name || "vulnerability";
  const title = `Reproduction recipe for ${projectLabel}${primaryVersion ? ` v${primaryVersion}` : ""}`;

  return {
    title,
    target,
    setupCommands,
    pocScript: poc?.script || null,
    pocLanguage: poc?.language || null,
    expectedOutput,
    dockerfile,
    notes,
    hardware: hardwareComponents,
  };
}
