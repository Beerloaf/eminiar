import { describe, expect, it } from "vitest";
import {
  forRemote,
  head,
  isSecretName,
  redact,
} from "../../src/adjudicator/redact.js";

/** [label, input, sentinel that must not survive] */
const LEAKS: Array<[string, string, string]> = [
  // name = value, any case, export prefix, quoted with spaces, YAML and JSON forms
  [
    "*_KEY after prose",
    "add this to .env: JWT_SIGNING_KEY=Zq9hunter2pass",
    "Zq9hunter2pass",
  ],
  [
    "ENCRYPTION_KEY",
    "ENCRYPTION_KEY=correct-horse-battery-staple",
    "correct-horse",
  ],
  ["*_PASS with &", "DB_PASS=Tr0ub4dor&3x", "Tr0ub4dor"],
  ["*_PASS keeps no tail", "DB_PASS=Tr0ub4dor&3x", "&3x"],
  ["*_PASSPHRASE", "GPG_PASSPHRASE=letmein-2026", "letmein-2026"],
  ["*_PASSWORD lower case", "export db_password=s3cr3t-value", "s3cr3t-value"],
  ["*_TOKEN export", "export GITHUB_TOKEN=abc123def456", "abc123def456"],
  ["*_SECRET", "CLIENT_SECRET = 'hello world 42'", "hello world 42"],
  ["*_CREDENTIALS", "GOOGLE_CREDENTIALS=c2VjcmV0LWNyZWRz", "c2VjcmV0LWNyZWRz"],
  ["camelCase apiKey", "const apiKey = 'abcd1234efgh'", "abcd1234efgh"],
  ["PGPASSWORD", "PGPASSWORD=pgS3cret psql -h db", "pgS3cret"],
  [
    "x-api-key header",
    "curl -H 'x-api-key: q1w2e3r4t5' https://x",
    "q1w2e3r4t5",
  ],
  [
    "JSON with spaces",
    'config: {"password": "open sesame please"}',
    "open sesame",
  ],
  [
    "quoted with spaces",
    'set password = "my very long passphrase"',
    "very long",
  ],
  ["escaped quote inside", 'password = "a \\"quoted\\" pw"', "quoted"],
  [
    "YAML key: value",
    "database:\n  password: hunter2hunter2\n  user: app",
    "hunter2hunter2",
  ],
  [
    "YAML block scalar",
    "secrets:\n  db_password: >\n    Sup3rS3cr3tFolded\n  user: app",
    "Sup3rS3cr3tFolded",
  ],
  ["Ruby hash rocket", "{ 'secret' => 'rocket-value-1' }", "rocket-value-1"],
  ["Go :=", 'token := "go-token-value"', "go-token-value"],
  [
    "npmrc _authToken",
    "//registry.npmjs.org/:_authToken=npm_AbCdEfGh12",
    "npm_AbCdEfGh12",
  ],
  [
    "URL query token",
    "GET https://api.example.com/v1?access_token=Q1w2E3r4T5y6&x=1",
    "Q1w2E3r4T5y6",
  ],
  [
    "connection string",
    "Server=db;User Id=app;Password=P@ss w0rd;Database=x",
    "P@ss",
  ],
  [
    "Azure AccountKey",
    "DefaultEndpointsProtocol=https;AccountName=a;AccountKey=abcDEF123==;",
    "abcDEF123",
  ],
  // Authorization headers
  [
    "Authorization: Basic",
    "curl -H 'Authorization: Basic YWRtaW46aHVudGVyMg==' https://x",
    "YWRtaW46",
  ],
  [
    "Authorization: Bearer",
    "Authorization: Bearer abc.def.ghi-123",
    "abc.def.ghi-123",
  ],
  [
    "Authorization: Token",
    "Authorization: Token 9944b09199c62bcf",
    "9944b09199c62bcf",
  ],
  // key blocks
  [
    "PEM RSA",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAsentinelLine\n-----END RSA PRIVATE KEY-----",
    "sentinelLine",
  ],
  [
    "OpenSSH",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktsentinel\n-----END OPENSSH PRIVATE KEY-----",
    "sentinel",
  ],
  [
    "PGP block",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBGSentinelPGPkey\n=AbCd\n-----END PGP PRIVATE KEY BLOCK-----",
    "SentinelPGPkey",
  ],
  [
    "unterminated PEM",
    "-----BEGIN PRIVATE KEY-----\nMIIEvQtruncatedSentinel",
    "truncatedSentinel",
  ],
  // provider token shapes
  [
    "Stripe sk_live",
    "use sk_live_51HxAbCdEfGh1234567 for billing",
    "51HxAbCdEfGh1234567",
  ],
  ["Stripe rk_live", "rk_live_AbCd1234EfGh5678", "AbCd1234EfGh5678"],
  ["Stripe pk_live", "pk_live_AbCd1234EfGh5678", "AbCd1234EfGh5678"],
  ["Slack xoxb", "xoxb-1234567890-abcdefghij", "abcdefghij"],
  ["Slack xoxe", "xoxe-1-abcdefghijklmn", "abcdefghijklmn"],
  [
    "GitHub ghp",
    "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "AbCdEfGhIjKlMnOpQrStUvWxYz",
  ],
  [
    "GitHub gho",
    "gho_AbCdEfGhIjKlMnOpQrStUvWxYz0123",
    "AbCdEfGhIjKlMnOpQrStUvWxYz",
  ],
  [
    "GitHub PAT",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
    "abcdefghijklmnop",
  ],
  ["AWS AKIA", "AKIAIOSFODNN7EXAMPLE", "IOSFODNN7EXAMPLE"],
  ["AWS ASIA", "ASIAIOSFODNN7EXAMPLE", "IOSFODNN7EXAMPLE"],
  [
    "AWS secret",
    "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "wJalrXUtnFEMI",
  ],
  [
    "Google AIza",
    "maps key AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW",
    "SyA1b2C3d4E5f6G7h8I9j0",
  ],
  [
    "JWT",
    "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "dozjgNryP4J3jVmNHl0w5N",
  ],
  [
    "SendGrid",
    "SG.AbCdEfGhIjKlMnOpQrStUv.wXyZ0123456789AbCdEfGhIjKlMnOpQrStUvWxYz0",
    "AbCdEfGhIjKl",
  ],
  [
    "npm token",
    "my npm token npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "AbCdEfGhIjKlMnOp",
  ],
  // URLs and command lines
  [
    "URL userinfo",
    "DATABASE_URL=postgres://app:S3cretPw@db.internal:5432/app",
    "S3cretPw",
  ],
  ["URL password only", "redis://:r3dispw@cache:6379", "r3dispw"],
  ["curl -u", "curl -u admin:hunter2pw https://api.example.com", "hunter2pw"],
  ["curl --user", "curl --user admin:hunter2pw https://x", "hunter2pw"],
  ["--password=", "run mysql --password=hunter2pw1 -h db", "hunter2pw1"],
  ["--password x", "run mysql --password hunter2pw2 -h db", "hunter2pw2"],
  ["--api-key x", "tool --api-key 'k3y-value' deploy", "k3y-value"],
  ["mysql -p", "mysql -uroot -pS3cr3tRootPw db", "S3cr3tRootPw"],
  ["mysqldump -p", "mysqldump -h db -u root -p'quoted pw' app", "quoted pw"],
  [
    "prose with a password-like word",
    "the admin password is Wint3rIsComing",
    "Wint3rIsComing",
  ],
  [
    "hex 24+",
    "secret hash 0123456789abcdef0123456789abcde",
    "0123456789abcdef0123456789abcde",
  ],
];

/** Must come back exactly as given. */
const KEEP: string[] = [
  "refactor src/adjudicator/config.ts and fix the race in useSessionStore; see commit 6db2683",
  "set timeout=5000 and retries: 3",
  "the keyEnv option names the env var that holds the key",
  "rename apiKeyName to keyName in the provider config",
  "keyEnv: ANTHROPIC_API_KEY",
  'apiKeyName: "ADJUDICATOR_KEY"',
  "token_count: 512 and max_tokens: 1024",
  "the password is required and must be rotated",
  "add a password field and a token input to the form",
  "password: ${DB_PASSWORD}",
  "api_key: process.env.API_KEY",
  "secret: <your secret here>",
  "auth: true",
  "monkey: banana and turkey=sandwich",
  "pass_through: yes",
  "docker run -p 8080:80 nginx",
  "gcc -pthread -o app main.c",
  "mkdir -p build/out",
  "npm install --save-dev vitest",
  "git commit --author 'Ryan <r@x>' --amend",
  "the Authorization header carries a token",
  "see https://example.com/docs?page=2&sort=asc",
  "const keyboard = new Keyboard(); keyboard.bind('k', go)",
  "export NODE_ENV=production PORT=3000",
  "secret_key_name: MY_SECRET",
  "use pk_test in docs",
  "-----BEGIN PUBLIC KEY-----",
];

describe("redact: secrets are masked", () => {
  for (const [label, input, sentinel] of LEAKS)
    it(label, () => {
      const out = redact(input);
      expect(out).not.toContain(sentinel);
      expect(redact(out)).toBe(out);
      expect(forRemote(input, 2000)).not.toContain(sentinel);
      expect(head(input, 200)).not.toContain(sentinel);
    });

  it("keeps the shape readable", () => {
    expect(redact("JWT_SIGNING_KEY=Zq9hunter2pass")).toBe(
      "JWT_SIGNING_KEY=***",
    );
    expect(redact('{"password": "open sesame please"}')).toBe(
      '{"password": "***"}',
    );
    expect(redact("Authorization: Basic YWRtaW46aHVudGVyMg==")).toBe(
      "Authorization: Basic ***",
    );
    expect(redact("curl -u admin:hunter2pw https://x")).toBe(
      "curl -u admin:*** https://x",
    );
    expect(redact("mysql -uroot -pS3cr3t db")).toBe("mysql -uroot -p*** db");
    expect(redact("sk_live_51HxAbCdEfGh1234567")).toBe("sk_live_***");
    expect(redact("?access_token=abc123&x=1")).toBe("?access_token=***&x=1");
    expect(
      redact(
        "a\n-----BEGIN PGP PRIVATE KEY BLOCK-----\nx\n-----END PGP PRIVATE KEY BLOCK-----\nb",
      ),
    ).toBe("a\n[private key]\nb");
  });

  it("masks a YAML block scalar only as deep as it is indented", () => {
    const yaml =
      "db:\n  password: |\n    line one\n    line two\n  user: app\nname: x";
    expect(redact(yaml)).toBe(
      "db:\n  password: |\n    ***\n  user: app\nname: x",
    );
  });
});

describe("redact: ordinary text survives", () => {
  for (const text of KEEP)
    it(JSON.stringify(text), () => {
      expect(redact(text)).toBe(text);
    });
});

describe("isSecretName", () => {
  it("matches secret suffixes in any case and style", () => {
    for (const n of [
      "JWT_SIGNING_KEY",
      "db_pass",
      "GPG_PASSPHRASE",
      "_authToken",
      "x-api-key",
      "apiKey",
      "APIKEY",
      "PGPASSWORD",
      "client.secret",
      "secret_key_base",
      "API_KEY_V2",
      "GOOGLE_CREDENTIALS",
    ])
      expect(isSecretName(n), n).toBe(true);
  });

  it("rejects names that only mention a secret", () => {
    for (const n of [
      "keyEnv",
      "apiKeyName",
      "token_count",
      "max_tokens",
      "keyboard",
      "monkey",
      "pass_through",
      "bypass",
      "key_id",
    ])
      expect(isSecretName(n), n).toBe(false);
  });
});

describe("redact: performance", () => {
  const time = (s: string): number => {
    const t0 = performance.now();
    redact(s);
    return performance.now() - t0;
  };
  // warm the regex JIT so the first measured run is not a compile
  redact("warm up DB_PASS=x curl -u a:b Authorization: Basic x".repeat(10));

  it("redacts 100 KB of realistic text in under 20 ms", () => {
    const chunk =
      "Please fix the race in src/session/store.ts where keyEnv is read twice; export DB_PASS=Tr0ub4dor&3x and " +
      'run `curl -u admin:pw https://x` then {"password": "a b c"} and ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123 ok.\n';
    const text = chunk
      .repeat(Math.ceil(100_000 / chunk.length))
      .slice(0, 100_000);
    const best = Math.min(time(text), time(text), time(text));
    expect(best).toBeLessThan(20);
  });

  it("has no catastrophic backtracking on pathological input", () => {
    const n = 100_000;
    const inputs = [
      "a".repeat(n),
      "a_".repeat(n / 2),
      "a=".repeat(n / 2),
      'a="'.repeat(n / 3),
      'password="'.concat("x".repeat(n)),
      "-----BEGIN ".concat("A".repeat(n)),
      "-----BEGIN PRIVATE KEY-----".repeat(n / 27),
      "x://".concat("a:".repeat(n / 2)),
      "--a-".repeat(n / 4),
      "mysql ".repeat(n / 6),
      "password is ".concat("1".repeat(n)),
      "Authorization: ".repeat(n / 15),
      "&a".repeat(n / 2),
      ";a ".repeat(n / 3),
      "key: |\n".concat(" x\n".repeat(n / 3)),
      "eyJ".concat("a".repeat(n)),
      "Aa1".repeat(n / 3),
      "a:".repeat(n / 2),
      "a.".repeat(n / 2),
      "a@".repeat(n / 2),
      "password=a;".repeat(n / 11),
      " -p".repeat(n / 3),
      "secret:".repeat(n / 7),
      "http://a:b@".repeat(n / 11),
      "--password ".repeat(n / 11),
      " -u a:".repeat(n / 6),
    ];
    for (const s of inputs) expect(time(s), s.slice(0, 20)).toBeLessThan(100);
  });
});
