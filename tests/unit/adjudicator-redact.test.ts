import { describe, expect, it } from "vitest";
import {
  forRemote,
  head,
  isSecretName,
  redact,
  redactSecrets,
} from "../../src/adjudicator/redact.js";

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
  // every Default_Ignorable_Code_Point, not just the zero-width ones (task #64)
  ["CGJ U+034F in name", "DB_PASS\u034FWORD=Hunt3rPw9xyz", "Hunt3rPw9xyz"],
  ["variation selector U+FE0F in name", "DB_PASS\uFE0FWORD=Hunt3rPw9xyz", "Hunt3rPw9xyz"],
  ["variation selector U+E0100 in name", "DB_PASS\u{E0100}WORD=Hunt3rPw9xyz", "Hunt3rPw9xyz"],
  ["tag char U+E0041 in name", "DB_PASS\u{E0041}WORD=Hunt3rPw9xyz", "Hunt3rPw9xyz"],
  ["Hangul filler U+3164 in name", "DB_PASS\u3164WORD=Hunt3rPw9xyz", "Hunt3rPw9xyz"],
  ["Hangul fillers U+115F U+1160", "DB_PASS\u115F\u1160WORD=Hunt3rPw9xyz", "Hunt3rPw9xyz"],
  ["halfwidth Hangul filler U+FFA0", "DB_PASS\uFFA0WORD=Hunt3rPw9xyz", "Hunt3rPw9xyz"],
  ["ALM U+061C in name", "DB_PASS\u061CWORD=Hunt3rPw9xyz", "Hunt3rPw9xyz"],
  ["Khmer vowel U+17B4 in name", "DB_PASS\u17B4WORD=Hunt3rPw9xyz", "Hunt3rPw9xyz"],
  ["Mongolian FVS U+180B in name", "DB_PASS\u180BWORD=Hunt3rPw9xyz", "Hunt3rPw9xyz"],
  ["invisible times U+2062 in name", "DB_PASS\u2062WORD=Hunt3rPw9xyz", "Hunt3rPw9xyz"],
  ["musical U+1D173 in name", "DB_PASS\u{1D173}WORD=Hunt3rPw9xyz", "Hunt3rPw9xyz"],
  ["NFKC ligature in name", "ﬁle_token=Hunt3rPw9xyz", "Hunt3rPw9xyz"],
  // nested YAML block scalars whose key hides a character (cleaned before the indentation pass)
  ["nested YAML block", "creds:\n  db_password: |\n    Hunt3rPw9xyz\n  user: x", "Hunt3rPw9xyz"],
  [
    "nested YAML block, ZWSP in key",
    "creds:\n  db_pass\u200Bword: |\n    Hunt3rPw9xyz\n  user: x",
    "Hunt3rPw9xyz",
  ],
  [
    "nested YAML block, fullwidth colon",
    "creds:\n  db_password\uFF1A |\n    Hunt3rPw9xyz\n  user: x",
    "Hunt3rPw9xyz",
  ],
  [
    "nested YAML block, tag char in key",
    "a:\n  b:\n    api\u{E0020}_key: >-\n      Hunt3rPw9xyz\n      more\n    c: 1",
    "Hunt3rPw9xyz",
  ],
  [
    "nested YAML block, ZWSP before the block line's indent",
    "creds:\n  db_password: |\n\u200B    Hunt3rPw9xyz\n  user: x",
    "Hunt3rPw9xyz",
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
    expect(redact("DB_PASS͏WORD=Hunt3rPw9")).toBe("DB_PASSWORD=***");
    expect(redact("DB_PASS\u{E0041}WORD=Hunt3rPw9")).toBe("DB_PASSWORD=***");
    expect(redact("DB_PASSㅤWORD=Hunt3rPw9")).toBe("DB_PASSWORD=***");
  });

  it("leaves no default-ignorable character in what it returns", () => {
    const hidden = "a­͏؜ᅟᅠ឴឵᠋᠎​‍‏";
    const more = "‪‮⁠⁤⁯ㅤ︀️﻿ﾠ\u{1D173}\u{E0001}\u{E0FFF}b";
    const ignorable = /\p{Default_Ignorable_Code_Point}/u;
    expect(redact(hidden + more)).toBe("ab");
    expect(ignorable.test(forRemote(hidden + more, 2000))).toBe(false);
    expect(ignorable.test(head(hidden + more, 200))).toBe(false);
  });

  it("masks nested YAML blocks through head() and forRemote() with the key cleaned first", () => {
    const zw = "creds:\n  db_pass​word: |\n    Hunt3rPw9xyz\n  user: x";
    expect(redact(zw)).toBe("creds:\n  db_password: |\n    ***\n  user: x");
    expect(forRemote(zw, 2000)).toBe("creds:\n db_password: |\n ***\n user: x");
    expect(head(zw, 200)).toBe("creds: db_password: | *** user: x");
    const fw = "creds:\n  db_password： |\n    Hunt3rPw9xyz\n  user: x";
    expect(forRemote(fw, 2000)).toBe("creds:\n db_password: |\n ***\n user: x");
  });

  it("does not turn a non-secret into a secret by stripping or normalising", () => {
    // the joined name is still not a secret name
    for (const text of [
      "token​count=12345abc",
      "max‌_tokens=4096",
      "pass­through=enabled1",
      "key⁠board=qwerty123",
      "api͏KeyName=primary1",
      "token_count： 12345abc",
      "Ｋｅｙｂｏａｒｄ＝ｑｗｅｒｔｙ123",
      "settings:\n  max​_tokens: |\n    4096 per call\n  user: x",
      "notes： |\n  the token is rotated\n  weekly",
    ]) {
      expect(redact(text), text).not.toContain("***");
      expect(forRemote(text, 2000), text).not.toContain("***");
      expect(head(text, 200), text).not.toContain("***");
    }
    // visible text around stripped characters is kept as it is
    expect(redact("ship it \u{1F44D}️, the ​build is green")).toBe(
      "ship it \u{1F44D}, the build is green",
    );
    expect(redact("﻿fix the cache key in src/a.ts")).toBe("fix the cache key in src/a.ts");
    expect(redact("한국어 텍스트는 그대로")).toBe("한국어 텍스트는 그대로");
  });

  it("still masks a plain secret next to stripped characters", () => {
    expect(redact("​DB_PASS=Hunt3rPw9 and⁠ API_KEY=Hunt3rPw8")).toBe("DB_PASS=*** and API_KEY=***");
    expect(forRemote("x­: DB_PASS=Hunt3rPw9", 2000)).toBe("x: DB_PASS=***");
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

describe("redactSecrets: stored command output", () => {
  // Only redact() cleans the text first, so a name hidden by an invisible or fullwidth character
  // is a remote-only case, like the generic hex run.
  const plain = (s: string) =>
    s.replace(/\p{Default_Ignorable_Code_Point}/gu, "").normalize("NFKC") === s;
  for (const [label, input, sentinel] of LEAKS)
    if (plain(input) && label !== "hex 24+")
      it(`masks ${label}`, () => {
        const out = redactSecrets(input);
        expect(out).not.toContain(sentinel);
        expect(redactSecrets(out)).toBe(out);
      });

  it("leaves ordinary text alone", () => {
    for (const text of KEEP) expect(redactSecrets(text)).toBe(text);
  });

  it("masks what `env` prints and keeps the rest", () => {
    const env = [
      "PATH=/usr/bin:/bin",
      "GH_TOKEN=ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
      "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "DATABASE_URL=postgres://app:Sup3rS3cret@db.internal:5432/app",
      "KUBECONFIG=/Users/me/.kube/config",
    ].join("\n");
    expect(redactSecrets(env)).toBe(
      [
        "PATH=/usr/bin:/bin",
        "GH_TOKEN=***",
        "AWS_ACCESS_KEY_ID=AKIA***",
        "AWS_SECRET_ACCESS_KEY=***",
        "DATABASE_URL=postgres://***@db.internal:5432/app",
        "KUBECONFIG=/Users/me/.kube/config",
      ].join("\n"),
    );
  });

  it("keeps what a search of the output looks for: SHAs, checksums, emails, base64, lone keys", () => {
    for (const text of [
      "commit 826dd7c8a1b2c3d4e5f60718293a4b5c6d7e8f90",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  empty.txt",
      "Author: Jane Doe <jane@example.com>",
      '"integrity": "sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg=="',
      'const fixture = "dGhpcyBpcyBhIGxvbmcgYmFzZTY0IHN0cmluZyB1c2VkIGluIHRlc3Rz"',
      '{ "Key": "photos/2024/beach.jpg", "Size": 120934 }',
      "+function pref(key: string, fallback: boolean): boolean {",
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
    // redact() is unchanged: for remote text those runs and a lone key still go.
    expect(redact('{ "Key": "photos/2024/beach.jpg" }')).toBe('{ "Key": "***" }');
    expect(redact("Author: Jane Doe <jane@example.com>")).toBe("Author: Jane Doe <[email]>");
    // Compound names are still secret, and a real key under a lone `key` keeps its shape rule.
    expect(redactSecrets("tls.key: LS0tLS1CRUdJTiBQUklW")).toBe("tls.key: ***");
    expect(redactSecrets('{"key": "sk-ant-api03-abcdefghijklmnop"}')).toBe('{"key": "sk-***"}');
  });

  it("keeps a lone key's name or path, and masks an opaque value under it", () => {
    for (const text of [
      'i18n: { key: "greeting.hello" }',
      "key = env/prod/terraform.tfstate",
      '{"Key": "logs/2024/11/08/app-server-1"}',
      "key: ab12",
      "KEY=ENABLE_FEATURE_FLAG_FOR_BETA",
      // object, cache and store keys: UUIDs, words between _ - : /, ISO dates, digests
      '{"Key": "550e8400-e29b-41d4-a716-446655440000"}',
      "key: 550E8400-E29B-41D4-A716-446655440000",
      '"Key": "user_123456_avatar_original_png"',
      '"Key": "2024-11-08T12:00:00Z_backup_v2_tar"',
      `key=sha256:${"0a1b2c3d".repeat(8)}`,
      `key: session:${"9f3a7c1e".repeat(4)}`,
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
    for (const [text, masked] of [
      ["KEY=Zx9Qw7Er5Ty3Ui1Op8As6Df4Gh2Jk", "KEY=***"],
      ["key=Zx9Qw7Er5Ty3Ui1Op8As6Df4Gh2Jk&x=1", "key=***&x=1"],
      ["datadog:\n  key: tsk9Qw7Er5Ty3Ui1Op8As6Df4Gh2Jk0Lz", "datadog:\n  key: ***"],
      // an env-prefixed token: a plain word beside a long opaque part
      ["key: live_Zx9Qw7Er5Ty3Ui1Op8As6Df4Gh2Jk", "key: ***"],
      ["key: test_Zx9Qw7Er5Ty3Ui1Op8As6Df4Gh2Jk", "key: ***"],
      ['KEY="prod-Zx9Qw7Er5Ty3Ui1Op8As6Df4Gh2Jk"', 'KEY="***"'],
      ['{"key": "key_live_Zx9Qw7Er5Ty3Ui1Op8As6Df4Gh2Jk"}', '{"key": "***"}'],
      ['"Key": "AB12CD34EF56GH78IJ90KL12/report-final"', '"Key": "***"'],
      // short parts, but no plain word among them: a base64url token with a dash
      ["key: Zx9Qw7Er5Ty3Ui1-Op8As6Df4Gh2Jk", "key: ***"],
      ['{"Key": "Zx9Qw7Er5Ty3Ui1Op8As6Df4Gh2Jk"}', '{"Key": "***"}'],
      [
        "data:\n  password: c3VwZXJzZWNyZXQ=\n  key: c2stbGl2ZS1zZWNyZXQ=",
        "data:\n  password: ***\n  key: ***",
      ],
    ] as const) {
      expect(redactSecrets(text)).toBe(masked);
    }
  });

  it("masks the bare tokens a CLI prints on their own", () => {
    for (const [text, masked] of [
      ["ya29.a0AfB_byC1x2y3z4ABCDEFGHIJKLMNOPQRSTUV", "ya29.***"],
      ["hvs.CAESIJ1x2y3z4ABCDEFGHIJKLMNOPQRSTUVwxyz", "hvs.***"],
      ["token               hvb.AAAAAQJ1x2y3z4ABCDEFGHIJKLMNOP", "token               hvb.***"],
      [`dop_v1_${"0a1b2c3d".repeat(8)}`, "dop_v1_***"],
      [`shpat_${"0123456789abcdef".repeat(2)}`, "shpat_***"],
      [`pypi-AgEIcHlwaS5vcmc${"A1b2C3".repeat(10)}`, "pypi-***"],
      [`eyJwYXlsb2FkIjoi${"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo".repeat(3)}`, "[ecr password]"],
    ] as const) {
      const out = redactSecrets(text);
      expect(out).toBe(masked);
      expect(redactSecrets(out)).toBe(out);
    }
  });

  it("masks a private key block without eating the output after a cut-off one", () => {
    const block =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAsentinelLine\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(`a\n${block}\nb`)).toBe("a\n[private key]\nb");
    const cut =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw\nMIIEvQIBADANBgkq";
    const log = `${cut}\n\ncommit 826dd7c\n    Fix the parser\n${block}\ntail`;
    expect(redactSecrets(log)).toBe(
      "[private key]\n\ncommit 826dd7c\n    Fix the parser\n[private key]\ntail",
    );
    // a key quoted on one line (JSON) and a cut-off one in a string
    expect(
      redactSecrets('"pem": "-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----\\n",'),
    ).toBe('"pem": "[private key]\\n",');
    expect(redactSecrets('["unterminated", "-----BEGIN PRIVATE KEY-----\\nMIIEvQ"],\nnext')).toBe(
      '["unterminated", "[private key]\nnext',
    );
    // indented (YAML, Helm values) or behind a diff marker, the cut-off body goes too
    const b64 = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw";
    expect(
      redactSecrets(`tls: |\n    -----BEGIN PRIVATE KEY-----\n    ${b64}\n    ${b64}\nrest`),
    ).toBe("tls: |\n    [private key]\nrest");
    expect(redactSecrets(`  -----BEGIN PRIVATE KEY-----\n  ${b64}\n- ${b64}\n> ${b64}\nrest`)).toBe(
      "  [private key]\nrest",
    );
    // redact() still masks a cut-off key to the end of the (short, remote) text
    expect(redact(`${cut}\n\ncommit 826dd7c`)).toBe("[private key]");
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
  const time = (s: string, f = redact): number => {
    const t0 = performance.now();
    f(s);
    return performance.now() - t0;
  };
  // warm the regex JIT so the first measured run is not a compile
  redact("warm up DB_PASS=x curl -u a:b Authorization: Basic x".repeat(10));

  it("redacts 100 KB of realistic text in under 20 ms, either pass", () => {
    const chunk =
      "Please fix the race in src/session/store.ts where keyEnv is read twice; export DB_PASS=Tr0ub4dor&3x and " +
      'run `curl -u admin:pw https://x` then {"password": "a b c"} and ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123 ok.\n' +
      "docker login -u me -p pw1x x.io; sshpass -p pw ssh -p 22 h; machine x.io login me password pw\n" +
      "curl -H 'Cookie: sid=abc; t=1' -b 'a=b' https://x and mkdir -p out\n";
    const text = chunk.repeat(Math.ceil(100_000 / chunk.length)).slice(0, 100_000);
    for (const f of [redact, redactSecrets]) {
      const best = Math.min(time(text, f), time(text, f), time(text, f));
      expect(best, f.name).toBeLessThan(20);
    }
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
      "\u{E0041}".repeat(n / 2),
      "ㅤa".repeat(n / 2),
      "a͏_".repeat(n / 3),
      "pass​word： |\n".concat(" x\n".repeat(n / 3)),
      "a： |\n".repeat(n / 5),
      // redactSecrets' private key rule: a window to END that stops at the next BEGIN
      "-----BEGIN PRIVATE KEY-----\n".repeat(n / 28),
      "-----BEGIN PRIVATE KEY-----".concat(" x".repeat(n / 2)),
      "-----BEGIN PRIVATE KEY-----".concat("\nAAAAAAAAAAAAAAAAAAAA".repeat(n / 21)),
      "-----BEGIN PRIVATE KEY-----".concat("-----END ".repeat(n / 9)),
      "-----BEGIN PRIVATE KEY-----\n".concat(" ".repeat(n)),
      "-----BEGIN PRIVATE KEY-----".concat(`\n${" ".repeat(98)}x`.repeat(n / 100)),
      "-----BEGIN PRIVATE KEY-----".concat("\n + > - AAAAAAAAAAAAAAAA".repeat(n / 26)),
      // redactSecrets' lone-key value test and token shapes
      "key=".concat("a1/".repeat(n / 3)),
      "key: a1\n".repeat(n / 8),
      "ya29.".repeat(n / 5),
      "eyJwYXlsb2FkIjoi".repeat(n / 16),
    ];
    // A quadratic rule on 100 KB is ~5e9 steps (seconds); a linear pass is a few ms. Under
    // parallel load (vitest workers, CI neighbours) an absolute 100 ms flakes, so the bound scales
    // with a linear baseline measured here, on the same machine under the same load, and a slow
    // input is re-timed before it fails. The bound stays an order of magnitude below a real
    // blow-up, so only a real blow-up fails.
    const plain = "the quick brown fox jumps over the lazy dog 0123456789\n".repeat(n / 55);
    for (const f of [redact, redactSecrets]) {
      const baseline = Math.min(time(plain, f), time(plain, f), time(plain, f));
      const bound = Math.max(100, 25 * baseline);
      for (const s of inputs) {
        let t = time(s, f);
        for (let retry = 0; retry < 2 && t >= bound; retry++) t = Math.min(t, time(s, f));
        expect(
          t,
          `${f.name} ${JSON.stringify(s.slice(0, 20))} (bound ${bound.toFixed(0)} ms)`,
        ).toBeLessThan(bound);
      }
    }
  });
});
