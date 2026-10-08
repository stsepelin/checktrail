export const syntheticSyntaxSources: Record<string, string> = {
  "sample.py":
    'fallback = "member"\ndef assign(role=fallback):\n    return "admin" if role == "owner" else "member"\ndef submit():\n    return assign()\n',
  "sample.go":
    'package sample\nvar fallback = "member"\nfunc assign(role string) string { if role == "owner" { return "admin" }; return fallback }\nfunc submit() string { return assign("owner") }\n',
  "sample.php":
    '<?php\nconst FALLBACK = "member";\nfunction assign($role = FALLBACK) { return $role === "owner" ? "admin" : "member"; }\nfunction submit() { return assign(); }\n',
  "sample.rs":
    'const FALLBACK: &str = "member";\nfn assign(role: &str) -> &str { if role == "owner" { "admin" } else { FALLBACK } }\nfn submit() -> &\'static str { assign("owner") }\n',
  "sample.java":
    'class Sample { static String fallback = "member"; static String assign(String role) { return role.equals("owner") ? "admin" : fallback; } static String submit() { return assign("owner"); } }\n',
  "sample.kt":
    'val fallback = "member"\nfun assign(role: String = fallback): String { return if (role == "owner") "admin" else fallback }\nfun submit(): String { return assign() }\n',
  "sample.scala":
    'object Sample { val fallback = "member"; def assign(role: String = fallback): String = if (role == "owner") "admin" else fallback; def submit(): String = assign() }\n',
  "sample.cs":
    'class Sample { const string fallback = "member"; static string assign(string role = fallback) { return role == "owner" ? "admin" : fallback; } static string submit() { return assign(); } }\n',
  "sample.fs":
    'module Sample\nlet fallback = "member"\nlet assign role = if role = "owner" then "admin" else fallback\nlet submit () = assign "owner"\n',
  "sample.fsi": "module Sample\nval assign: string -> string\n",
  "sample.rb":
    'FALLBACK = "member"\ndef assign(role = FALLBACK)\n  role == "owner" ? "admin" : "member"\nend\ndef submit\n  assign()\nend\n',
  "sample.swift":
    'let fallback = "member"\nfunc assign(role: String = "member") -> String { return role == "owner" ? "admin" : fallback }\nfunc submit() -> String { return assign() }\n',
  "sample.c":
    "const int fallback = 0;\nint assign(int role) { return role == 1 ? 2 : fallback; }\nint submit(void) { return assign(1); }\n",
  "sample.cpp":
    "constexpr int fallback = 0;\nint assign(int role = fallback) { return role == 1 ? 2 : fallback; }\nint submit() { return assign(); }\n",
  "sample.tf":
    'variable "role" { default = "member" }\nlocals { assigned = var.role == "owner" ? "admin" : "member" }\n',
  "sample.yaml": "roles:\n  default: member\n  owner: admin\n",
};
