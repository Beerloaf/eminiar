import { describe, expect, it } from "vitest";
import { forRemote, head, isSecretName, redact } from "../../src/adjudicator/redact.js";

/** [label, input, sentinel that must not survive] */
const LEAKS: Array<[string, string, string]> = [
  // name = value, any case, export prefix, quoted with spaces, YAML and JSON forms
  ["*_KEY after prose", "add this to .env: JWT_SIGNING_KEY=Zq9hunter2pass", "Zq9hunter2pass"],
  ["ENCRYPTION_KEY", "ENCRYPTION_KEY=correct-horse-battery-staple", "correct-horse"],
  ["*_PASS with &", "DB_PASS=Tr0ub4dor&3x", "Tr0ub4dor"],
  ["*_PASS keeps no tail", "DB_PASS=Tr0ub4dor&3x", "&3x"],
  ["*_PASSPHRASE", "GPG_PASSPHRASE=letmein-2026", "letmein-2026"],
  ["*_PASSWORD lower case", "export db_password=s3cr3t-value", "s3cr3t-value"],
  ["*_TOKEN export", "export GITHUB_TOKEN=abc123def456", "abc123def456"],
  ["*_SECRET", "CLIENT_SECRET = 'hello world 42'", "hello world 42"],
  ["*_CREDENTIALS", "GOOGLE_CREDENTIALS=c2VjcmV0LWNyZWRz", "c2VjcmV0LWNyZWRz"],
  ["camelCase apiKey", "const apiKey = 'abcd1234efgh'", "abcd1234efgh"],
  ["PGPASSWORD", "PGPASSWORD=pgS3cret psql -h db", "pgS3cret"],
  ["x-api-key header", "curl -H 'x-api-key: q1w2e3r4t5' https://x", "q1w2e3r4t5"],
  ["JSON with spaces", 'config: {"password": "open sesame please"}', "open sesame"],
  ["quoted with spaces", 'set password = "my very long passphrase"', "very long"],
  ["escaped quote inside", 'password = "a \\"quoted\\" pw"', "quoted"],
  ["YAML key: value", "database:\n  password: hunter2hunter2\n  user: app", "hunter2hunter2"],
  [
    "YAML block scalar",
    "secrets:\n  db_password: >\n    Sup3rS3cr3tFolded\n  user: app",
    "Sup3rS3cr3tFolded",
  ],
  ["Ruby hash rocket", "{ 'secret' => 'rocket-value-1' }", "rocket-value-1"],
  ["Go :=", 'token := "go-token-value"', "go-token-value"],
  ["npmrc _authToken", "//registry.npmjs.org/:_authToken=npm_AbCdEfGh12", "npm_AbCdEfGh12"],
  [
    "URL query token",
    "GET https://api.example.com/v1?access_token=Q1w2E3r4T5y6&x=1",
    "Q1w2E3r4T5y6",
  ],
  ["connection string", "Server=db;User Id=app;Password=P@ss w0rd;Database=x", "P@ss"],
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
  ["Authorization: Bearer", "Authorization: Bearer abc.def.ghi-123", "abc.def.ghi-123"],
  ["Authorization: Token", "Authorization: Token 9944b09199c62bcf", "9944b09199c62bcf"],
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
  ["unterminated PEM", "-----BEGIN PRIVATE KEY-----\nMIIEvQtruncatedSentinel", "truncatedSentinel"],
  // provider token shapes
  ["Stripe sk_live", "use sk_live_51HxAbCdEfGh1234567 for billing", "51HxAbCdEfGh1234567"],
  ["Stripe rk_live", "rk_live_AbCd1234EfGh5678", "AbCd1234EfGh5678"],
  ["Stripe pk_live", "pk_live_AbCd1234EfGh5678", "AbCd1234EfGh5678"],
  ["Slack xoxb", "xoxb-1234567890-abcdefghij", "abcdefghij"],
  ["Slack xoxe", "xoxe-1-abcdefghijklmn", "abcdefghijklmn"],
  ["GitHub ghp", "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "AbCdEfGhIjKlMnOpQrStUvWxYz"],
  ["GitHub gho", "gho_AbCdEfGhIjKlMnOpQrStUvWxYz0123", "AbCdEfGhIjKlMnOpQrStUvWxYz"],
  ["GitHub PAT", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "abcdefghijklmnop"],
  ["AWS AKIA", "AKIAIOSFODNN7EXAMPLE", "IOSFODNN7EXAMPLE"],
  ["AWS ASIA", "ASIAIOSFODNN7EXAMPLE", "IOSFODNN7EXAMPLE"],
  [
    "AWS secret",
    "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "wJalrXUtnFEMI",
  ],
  ["Google AIza", "maps key AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW", "SyA1b2C3d4E5f6G7h8I9j0"],
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
  ["npm token", "my npm token npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "AbCdEfGhIjKlMnOp"],
  // URLs and command lines
  ["URL userinfo", "DATABASE_URL=postgres://app:S3cretPw@db.internal:5432/app", "S3cretPw"],
  ["URL password only", "redis://:r3dispw@cache:6379", "r3dispw"],
  ["curl -u", "curl -u admin:hunter2pw https://api.example.com", "hunter2pw"],
  ["curl --user", "curl --user admin:hunter2pw https://x", "hunter2pw"],
  ["--password=", "run mysql --password=hunter2pw1 -h db", "hunter2pw1"],
  ["--password x", "run mysql --password hunter2pw2 -h db", "hunter2pw2"],
  ["--api-key x", "tool --api-key 'k3y-value' deploy", "k3y-value"],
  ["mysql -p", "mysql -uroot -pS3cr3tRootPw db", "S3cr3tRootPw"],
  ["mysqldump -p", "mysqldump -h db -u root -p'quoted pw' app", "quoted pw"],
  ["prose with a password-like word", "the admin password is Wint3rIsComing", "Wint3rIsComing"],
  ["prose secret is", "the stripe webhook signing secret is Hunt3rPw9xyz", "Hunt3rPw9xyz"],
  ["hex 24+", "secret hash 0123456789abcdef0123456789abcde", "0123456789abcdef0123456789abcde"],
  // CLI password flags and credential files
  ["docker login -p", "docker login -u deploy -p Hunt3rPw9 registry.example.com", "Hunt3rPw9"],
  ["podman login -p quoted", "podman login -u me -p 'Hunt3r Pw9' quay.io", "Hunt3r Pw9"],
  ["helm registry login -p", "helm registry login ghcr.io -u me -p Hunt3rPw9", "Hunt3rPw9"],
  ["docker login --password", "docker login --password Hunt3rPw9 x.io", "Hunt3rPw9"],
  [
    "echo | docker login --password-stdin",
    "echo Hunt3rPw9 | docker login -u me --password-stdin ghcr.io",
    "Hunt3rPw9",
  ],
  [
    "printf | --password-stdin",
    "printf '%s' 'Hunt3rPw9' | podman login --password-stdin -u me quay.io",
    "Hunt3rPw9",
  ],
  ["--password-stdin <<<", "docker login -u me --password-stdin <<< 'Hunt3rPw9' x.io", "Hunt3rPw9"],
  ["sshpass -p", "sshpass -p 'Hunt3rPw9' ssh admin@10.0.0.4", "Hunt3rPw9"],
  ["sshpass -p attached", "sshpass -pHunt3rPw9 ssh admin@host", "Hunt3rPw9"],
  ["sshpass -v -p", "sshpass -v -p Hunt3rPw9 ssh -p 2222 admin@host", "Hunt3rPw9"],
  ["redis-cli -a", "redis-cli -h cache -a Hunt3rPw9 ping", "Hunt3rPw9"],
  ["mongosh -p", "mongosh --host db -u admin -p Hunt3rPw9", "Hunt3rPw9"],
  ["ldapsearch -w", "ldapsearch -x -D cn=admin -w Hunt3rPw9 -b dc=x", "Hunt3rPw9"],
  ["zip -P", "zip -r -P Hunt3rPw9 out.zip dir", "Hunt3rPw9"],
  ["7z -p", "7z a -pHunt3rPw9 out.7z dir", "Hunt3rPw9"],
  ["htpasswd -b", "htpasswd -b .htpasswd admin Hunt3rPw9", "Hunt3rPw9"],
  ["htpasswd -nb", "htpasswd -nb admin Hunt3rPw9", "Hunt3rPw9"],
  ["openssl pass:", "openssl rsa -in k.pem -passin pass:Hunt3rPw9 -out x.pem", "Hunt3rPw9"],
  ["keytool -storepass", "keytool -list -keystore ks.jks -storepass Hunt3rPw9", "Hunt3rPw9"],
  ["smbclient -U user%pass", "smbclient //srv/share -U admin%Hunt3rPw9", "Hunt3rPw9"],
  ["--token=", "gh auth --token=Hunt3rPw9xyz", "Hunt3rPw9xyz"],
  [
    "kubectl --from-literal",
    "kubectl create secret generic db --from-literal=password=Hunt3rPw9",
    "Hunt3rPw9",
  ],
  [
    ".netrc one line",
    "my ~/.netrc has: machine api.heroku.com login me password Hunt3rPw9",
    "Hunt3rPw9",
  ],
  [".netrc password first", "machine github.com password Hunt3rPw9 login me", "Hunt3rPw9"],
  [
    ".netrc multi-line",
    "machine api.heroku.com\n  login me@x.io\n  password Hunt3rPw9\n",
    "Hunt3rPw9",
  ],
  [".netrc default", "default login anonymous password Hunt3rPw9", "Hunt3rPw9"],
  [".netrc login/password lines", "login me\npassword Hunt3rPw9", "Hunt3rPw9"],
  ["Cookie header", "Cookie: session=Hunt3rPw9xyzLongSessionValue", "Hunt3rPw9xyz"],
  ["Cookie second value", "cookie: a=1; csrftoken=Hunt3rPw9xyz", "Hunt3rPw9xyz"],
  [
    "Set-Cookie",
    "Set-Cookie: sid=Hunt3rPw9xyz; Path=/; HttpOnly; Secure; SameSite=Lax",
    "Hunt3rPw9xyz",
  ],
  ["curl -H Cookie", "curl -H 'Cookie: sid=Hunt3rPw9xyz' https://x", "Hunt3rPw9xyz"],
  ["curl -b", "curl -b 'sid=Hunt3rPw9xyz; theme=dark' https://x", "Hunt3rPw9xyz"],
  ["curl --cookie", "curl --cookie sid=Hunt3rPw9xyz https://x", "Hunt3rPw9xyz"],
  // invisible and compatibility characters inside a secret's name
  ["zero-width in name", "PASS​WORD=Hunt3rPw9", "Hunt3rPw9"],
  ["BOM and soft hyphen in name", "DB_PAS­S=Hunt3rPw9 ﻿API_KEY=Hunt3rPw8", "Hunt3rPw"],
  ["fullwidth =", "DB_PASSWORD＝Hunt3rPw9", "Hunt3rPw9"],
  ["fullwidth name", "ＤＢ_ＰＡＳＳ=Hunt3rPw9", "Hunt3rPw9"],
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
  // A shell-style placeholder, not a template: built without a literal "${" in a plain string.
  `password: $${"{"}DB_PASSWORD}`,
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
  // short flags that are not passwords
  "mkdir -p src/a/b && cp -p a.txt b.txt",
  "ssh -p 22 admin@host",
  "scp -P 2222 file host:/tmp",
  "psql -h db -p 5432 -U postgres app",
  "docker login ghcr.io && docker run -p 8080:80 nginx",
  "docker login -u me --password-stdin ghcr.io",
  "echo $CR_PAT | docker login ghcr.io -u me --password-stdin",
  'echo "$TOKEN" | docker login --password-stdin',
  "sshpass -f pw.txt ssh -p 22 admin@host",
  "sshpass -e ssh -p 2222 admin@host",
  "redis-cli -h cache -p 6379 ping",
  "git checkout -b feature/redact",
  "htpasswd -c .htpasswd admin",
  "openssl rsa -in k.pem -passin env:KEY_PASS",
  "keytool -list -storepass:env STORE_PASS",
  "curl -b cookies.txt https://x",
  "gzip -P 4 big.log",
  "tar -czpf out.tgz dir",
  // prose that only mentions the words
  "the machine password is managed by vault",
  "by default the password is required",
  "the token is expired and the secret was rotated",
  "the login page password field is blank",
  "set a cookie: it expires",
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
    expect(redact("JWT_SIGNING_KEY=Zq9hunter2pass")).toBe("JWT_SIGNING_KEY=***");
    expect(redact('{"password": "open sesame please"}')).toBe('{"password": "***"}');
    expect(redact("Authorization: Basic YWRtaW46aHVudGVyMg==")).toBe("Authorization: Basic ***");
    expect(redact("curl -u admin:hunter2pw https://x")).toBe("curl -u admin:*** https://x");
    expect(redact("mysql -uroot -pS3cr3t db")).toBe("mysql -uroot -p*** db");
    expect(redact("sk_live_51HxAbCdEfGh1234567")).toBe("sk_live_***");
    expect(redact("?access_token=abc123&x=1")).toBe("?access_token=***&x=1");
    expect(
      redact("a\n-----BEGIN PGP PRIVATE KEY BLOCK-----\nx\n-----END PGP PRIVATE KEY BLOCK-----\nb"),
    ).toBe("a\n[private key]\nb");
  });

  it("keeps the command and the names around a masked CLI password or cookie", () => {
    expect(redact("docker login -u deploy -p Hunt3rPw9 registry.example.com")).toBe(
      "docker login -u deploy -p *** registry.example.com",
    );
    expect(redact("sshpass -p 'Hunt3rPw9' ssh -p 22 admin@host")).toBe(
      "sshpass -p '***' ssh -p 22 admin@host",
    );
    expect(redact("docker login -u me -p pw1x && docker run -p 8080:80 nginx")).toBe(
      "docker login -u me -p *** && docker run -p 8080:80 nginx",
    );
    expect(redact("htpasswd -nb admin Hunt3rPw9")).toBe("htpasswd -nb admin ***");
    expect(redact("smbclient //s/x -U admin%Hunt3rPw9")).toBe("smbclient //s/x -U admin%***");
    expect(redact("machine github.com login me password Hunt3rPw9")).toBe(
      "machine github.com login me password ***",
    );
    expect(redact('machine x.io login me password "a b"')).toBe(
      'machine x.io login me password "***"',
    );
    expect(redact("Cookie: a=1; csrftoken=Hunt3rPw9xyz")).toBe("Cookie: a=***; csrftoken=***");
    expect(redact("Set-Cookie: sid=Hunt3rPw9; Path=/; Max-Age=3600; HttpOnly")).toBe(
      "Set-Cookie: sid=***; Path=/; Max-Age=3600; HttpOnly",
    );
    expect(redact("echo Hunt3rPw9 | docker login --password-stdin")).toBe(
      "echo *** | docker login --password-stdin",
    );
  });

  it("strips invisible characters and applies NFKC before matching", () => {
    expect(redact("PASS​WORD=Hunt3rPw9")).toBe("PASSWORD=***");
    expect(redact("DB_PASSWORD＝Hunt3rPw9")).toBe("DB_PASSWORD=***");
  });

  it("masks a YAML block scalar only as deep as it is indented", () => {
    const yaml = "db:\n  password: |\n    line one\n    line two\n  user: app\nname: x";
    expect(redact(yaml)).toBe("db:\n  password: |\n    ***\n  user: app\nname: x");
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
      'run `curl -u admin:pw https://x` then {"password": "a b c"} and ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123 ok.\n' +
      "docker login -u me -p pw1x x.io; sshpass -p pw ssh -p 22 h; machine x.io login me password pw\n" +
      "curl -H 'Cookie: sid=abc; t=1' -b 'a=b' https://x and mkdir -p out\n";
    const text = chunk.repeat(Math.ceil(100_000 / chunk.length)).slice(0, 100_000);
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
      "docker login ".repeat(n / 13),
      "docker login -p".repeat(n / 15),
      "redis-cli -a".repeat(n / 12),
      "sshpass -v x".repeat(n / 12),
      "sshpass".concat(" -f x".repeat(n / 5)),
      "htpasswd -b".repeat(n / 11),
      "htpasswd".concat(" -b a".repeat(n / 5)),
      "echo a ".repeat(n / 7),
      "echo a | ".repeat(n / 9),
      "--password-stdin ".repeat(n / 17),
      "--password-stdin <<<".repeat(n / 20),
      "machine a ".repeat(n / 10),
      "machine a login b ".repeat(n / 18),
      "machine a".concat(" ".repeat(n)),
      "machine a".concat("\n".repeat(n)),
      "login a\n".repeat(n / 8),
      "Cookie: ".repeat(n / 8),
      "Cookie: ".concat("a=b;".repeat(n / 4)),
      "Cookie: a".concat("=".repeat(n)),
      "curl -b".repeat(n / 7),
      " -U a%".repeat(n / 6),
      "-passin pass:".repeat(n / 13),
      "-storepass ".repeat(n / 11),
      "7z -p".repeat(n / 5),
      "secret is 1".repeat(n / 11),
      "​".repeat(n),
      "a​=".repeat(n / 3),
    ];
    for (const s of inputs) expect(time(s), s.slice(0, 20)).toBeLessThan(100);
  });
});
