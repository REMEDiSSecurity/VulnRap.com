import { describe, it, expect } from "vitest";
import { checkPrivateHost, __TESTING__ } from "./private-host-guard";

const { isBlockedIPv4, isBlockedIPv6, isBlockedHostname, expandIPv6 } =
  __TESTING__;

describe("isBlockedIPv4", () => {
  it.each([
    "127.0.0.1",
    "127.5.5.5",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "169.254.169.254",
    "169.254.0.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
  ])("blocks %s", (ip) => {
    expect(isBlockedIPv4(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "192.169.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "169.255.0.1",
  ])("allows public %s", (ip) => {
    expect(isBlockedIPv4(ip)).toBe(false);
  });
});

describe("isBlockedIPv6", () => {
  it("blocks loopback and unspecified", () => {
    expect(isBlockedIPv6("::1")).toBe(true);
    expect(isBlockedIPv6("::")).toBe(true);
  });
  it("blocks unique-local fc00::/7", () => {
    expect(isBlockedIPv6("fc00::1")).toBe(true);
    expect(isBlockedIPv6("fd12:3456:789a::1")).toBe(true);
  });
  it("blocks link-local fe80::/10", () => {
    expect(isBlockedIPv6("fe80::1")).toBe(true);
    expect(isBlockedIPv6("fe80::abcd")).toBe(true);
  });
  it("blocks IPv4-mapped private ranges", () => {
    expect(isBlockedIPv6("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIPv6("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedIPv6("::ffff:169.254.169.254")).toBe(true);
  });
  it("allows global unicast", () => {
    expect(isBlockedIPv6("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedIPv6("2001:4860:4860::8888")).toBe(false);
  });
});

describe("isBlockedHostname", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "anything.localhost",
    "metadata.google.internal",
    "metadata",
    "foo.internal",
  ])("blocks %s", (h) => {
    expect(isBlockedHostname(h)).toBe(true);
  });

  it.each(["example.com", "vulnrap.com", "internal-tools.example.com"])(
    "allows %s",
    (h) => {
      expect(isBlockedHostname(h)).toBe(false);
    },
  );
});

describe("expandIPv6", () => {
  it("expands :: to a fully padded canonical form", () => {
    expect(expandIPv6("::1")).toBe("0000:0000:0000:0000:0000:0000:0000:0001");
    expect(expandIPv6("fe80::1")).toBe(
      "fe80:0000:0000:0000:0000:0000:0000:0001",
    );
  });
  it("returns null for malformed input", () => {
    expect(expandIPv6("not-an-ipv6")).toBeNull();
    expect(expandIPv6("1::2::3")).toBeNull();
  });
});

describe("checkPrivateHost", () => {
  it("rejects loopback URLs", async () => {
    const r = await checkPrivateHost("http://127.0.0.1:8080/x");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blocked range/);
  });

  it("rejects the AWS/GCE metadata IP", async () => {
    const r = await checkPrivateHost(
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    );
    expect(r.ok).toBe(false);
    expect(r.blockedIps).toContain("169.254.169.254");
  });

  it("rejects [::1] IPv6 loopback", async () => {
    const r = await checkPrivateHost("http://[::1]:9000/");
    expect(r.ok).toBe(false);
  });

  it("rejects RFC1918 literal", async () => {
    const r = await checkPrivateHost("http://10.0.0.5/admin");
    expect(r.ok).toBe(false);
  });

  it("rejects 'localhost' hostname before DNS", async () => {
    const r = await checkPrivateHost("https://localhost/x");
    expect(r.ok).toBe(false);
  });

  it("rejects *.internal hostnames", async () => {
    const r = await checkPrivateHost("https://service.internal/x");
    expect(r.ok).toBe(false);
  });

  it("rejects unsupported protocols", async () => {
    const r = await checkPrivateHost("ftp://example.com/x");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/protocol/);
  });

  it("rejects unparseable urls", async () => {
    const r = await checkPrivateHost("not-a-url");
    expect(r.ok).toBe(false);
  });

  it("rejects when DNS resolves to a private IP", async () => {
    const r = await checkPrivateHost("https://evil.example.com/x", {
      resolve: async () => ["10.1.2.3"],
    });
    expect(r.ok).toBe(false);
    expect(r.blockedIps).toEqual(["10.1.2.3"]);
  });

  it("rejects when DNS returns no addresses", async () => {
    const r = await checkPrivateHost("https://nx.example.com/x", {
      resolve: async () => [],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects when DNS resolution throws", async () => {
    const r = await checkPrivateHost("https://broken.example.com/x", {
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/dns/i);
  });

  it("allows public hostnames whose DNS resolves to public IPs", async () => {
    const r = await checkPrivateHost("https://api.example.com/hook", {
      resolve: async () => ["93.184.216.34"],
    });
    expect(r.ok).toBe(true);
  });

  it("allows public literal IPs", async () => {
    const r = await checkPrivateHost("https://8.8.8.8/");
    expect(r.ok).toBe(true);
  });

  it("strips a trailing dot from FQDNs before checking", async () => {
    const r = await checkPrivateHost("https://localhost./x");
    expect(r.ok).toBe(false);
  });
});
