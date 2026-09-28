import type { Octokit } from "@octokit/rest";

// A small in-memory GitHub covering exactly the REST calls pr-bumper.ts and
// alerts.ts make: repos, the git data API (blobs, trees, commits, refs),
// pulls and issues. Enough state to assert what a bump run leaves behind.

type Mode = "100644" | "100755" | "040000";
interface Entry {
  path: string;
  mode: Mode;
  type: "blob" | "tree";
  sha: string;
}
interface Commit {
  tree: string;
  parents: string[];
  message: string;
}
export interface FakePr {
  number: number;
  state: "open" | "closed";
  merged_at: string | null;
  html_url: string;
  title: string;
  body: string;
  base: string;
  head: { ref: string; repo: { full_name: string } | null };
  reviewers: string[];
}
export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  comments: string[];
}

interface Repo {
  fullName: string;
  defaultBranch: string;
  refs: Map<string, string>;
  commits: Map<string, Commit>;
  trees: Map<string, Entry[]>;
  blobs: Map<string, string>;
  pulls: FakePr[];
  issues: FakeIssue[];
}

const httpError = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

export class FakeGitHub {
  private repos = new Map<string, Repo>();
  private seq = 0;
  private next = 1;
  // Test hook: make pulls.create throw once.
  failNextPullCreate: Error | null = null;
  calls: string[] = [];

  private sha(): string {
    return (++this.seq).toString(16).padStart(40, "0");
  }

  private repo(owner: string, repo: string): Repo {
    const r = this.repos.get(`${owner}/${repo}`.toLowerCase());
    if (!r) throw httpError(404, `Not Found: ${owner}/${repo}`);
    return r;
  }

  addRepo(
    fullName: string,
    files: Record<string, string | { content: string; mode: "100644" | "100755" }>,
    defaultBranch = "main",
  ): string {
    const r: Repo = {
      fullName,
      defaultBranch,
      refs: new Map(),
      commits: new Map(),
      trees: new Map(),
      blobs: new Map(),
      pulls: [],
      issues: [],
    };
    this.repos.set(fullName.toLowerCase(), r);
    const flat = new Map<string, { mode: Mode; sha: string }>();
    for (const [path, spec] of Object.entries(files)) {
      const { content, mode } =
        typeof spec === "string" ? { content: spec, mode: "100644" as const } : spec;
      const sha = this.sha();
      r.blobs.set(sha, Buffer.from(content).toString("base64"));
      flat.set(path, { mode, sha });
    }
    const tree = this.buildTree(r, flat);
    const commit = this.sha();
    r.commits.set(commit, { tree, parents: [], message: "initial" });
    r.refs.set(defaultBranch, commit);
    return commit;
  }

  private buildTree(r: Repo, flat: Map<string, { mode: Mode; sha: string }>): string {
    const here: Entry[] = [];
    const dirs = new Map<string, Map<string, { mode: Mode; sha: string }>>();
    for (const [path, v] of flat) {
      const [head, ...rest] = path.split("/");
      if (!rest.length) {
        here.push({ path: head, mode: v.mode, type: "blob", sha: v.sha });
      } else {
        if (!dirs.has(head)) dirs.set(head, new Map());
        dirs.get(head)!.set(rest.join("/"), v);
      }
    }
    for (const [name, sub] of dirs) {
      here.push({ path: name, mode: "040000", type: "tree", sha: this.buildTree(r, sub) });
    }
    const sha = this.sha();
    r.trees.set(sha, here);
    return sha;
  }

  private flatten(r: Repo, treeSha: string, prefix = ""): Map<string, { mode: Mode; sha: string }> {
    const out = new Map<string, { mode: Mode; sha: string }>();
    for (const e of r.trees.get(treeSha) ?? []) {
      const p = prefix + e.path;
      if (e.type === "tree") {
        for (const [k, v] of this.flatten(r, e.sha, `${p}/`)) out.set(k, v);
      } else {
        out.set(p, { mode: e.mode, sha: e.sha });
      }
    }
    return out;
  }

  // Assertions ------------------------------------------------------------

  readFile(fullName: string, branch: string, path: string): string | undefined {
    const r = this.repos.get(fullName.toLowerCase())!;
    const commit = r.refs.get(branch);
    if (!commit) return undefined;
    const blob = this.flatten(r, r.commits.get(commit)!.tree).get(path);
    return blob && Buffer.from(r.blobs.get(blob.sha)!, "base64").toString("utf8");
  }

  fileMode(fullName: string, branch: string, path: string): string | undefined {
    const r = this.repos.get(fullName.toLowerCase())!;
    const commit = r.refs.get(branch)!;
    return this.flatten(r, r.commits.get(commit)!.tree).get(path)?.mode;
  }

  commitOf(fullName: string, branch: string): Commit & { sha: string } {
    const r = this.repos.get(fullName.toLowerCase())!;
    const sha = r.refs.get(branch)!;
    return { sha, ...r.commits.get(sha)! };
  }

  branches(fullName: string): string[] {
    return [...this.repos.get(fullName.toLowerCase())!.refs.keys()].sort();
  }

  pulls(fullName: string): FakePr[] {
    return this.repos.get(fullName.toLowerCase())!.pulls;
  }

  issues(fullName: string): FakeIssue[] {
    return this.repos.get(fullName.toLowerCase())!.issues;
  }

  // Seed a PR as if an earlier run (or a human) had opened it.
  addPull(
    fullName: string,
    pr: { ref: string; state?: "open" | "closed"; merged?: boolean; createBranch?: boolean },
  ): FakePr {
    const r = this.repos.get(fullName.toLowerCase())!;
    if (pr.createBranch ?? true) r.refs.set(pr.ref, r.refs.get(r.defaultBranch)!);
    const number = this.next++;
    const created: FakePr = {
      number,
      state: pr.state ?? "open",
      merged_at: pr.merged ? "2026-09-01T00:00:00Z" : null,
      html_url: `https://github.com/${fullName}/pull/${number}`,
      title: `seeded ${pr.ref}`,
      body: "",
      base: r.defaultBranch,
      head: { ref: pr.ref, repo: { full_name: fullName } },
      reviewers: [],
    };
    r.pulls.push(created);
    return created;
  }

  // Octokit surface --------------------------------------------------------

  readonly octokit = {
    paginate: async <P, T>(fn: (p: P) => Promise<{ data: T[] }>, params: P): Promise<T[]> =>
      (await fn(params)).data,

    repos: {
      get: async ({ owner, repo }: { owner: string; repo: string }) => {
        this.calls.push("repos.get");
        return { data: { default_branch: this.repo(owner, repo).defaultBranch } };
      },
    },

    git: {
      getRef: async ({ owner, repo, ref }: { owner: string; repo: string; ref: string }) => {
        const sha = this.repo(owner, repo).refs.get(ref.replace(/^heads\//, ""));
        if (!sha) throw httpError(404, "Not Found");
        return { data: { object: { sha } } };
      },
      getCommit: async (p: { owner: string; repo: string; commit_sha: string }) => {
        const c = this.repo(p.owner, p.repo).commits.get(p.commit_sha);
        if (!c) throw httpError(404, "Not Found");
        return { data: { tree: { sha: c.tree } } };
      },
      getTree: async (p: { owner: string; repo: string; tree_sha: string }) => {
        const t = this.repo(p.owner, p.repo).trees.get(p.tree_sha);
        if (!t) throw httpError(404, "Not Found");
        return { data: { tree: t.map((e) => ({ ...e })) } };
      },
      getBlob: async (p: { owner: string; repo: string; file_sha: string }) => {
        const b = this.repo(p.owner, p.repo).blobs.get(p.file_sha);
        if (b === undefined) throw httpError(404, "Not Found");
        return { data: { content: b, encoding: "base64" } };
      },
      createBlob: async (p: { owner: string; repo: string; content: string; encoding: string }) => {
        this.calls.push("git.createBlob");
        const sha = this.sha();
        const content =
          p.encoding === "base64" ? p.content : Buffer.from(p.content).toString("base64");
        this.repo(p.owner, p.repo).blobs.set(sha, content);
        return { data: { sha } };
      },
      createTree: async (p: {
        owner: string;
        repo: string;
        base_tree: string;
        tree: { path: string; mode: Mode; sha: string }[];
      }) => {
        this.calls.push("git.createTree");
        const r = this.repo(p.owner, p.repo);
        const flat = this.flatten(r, p.base_tree);
        for (const e of p.tree) flat.set(e.path, { mode: e.mode, sha: e.sha });
        return { data: { sha: this.buildTree(r, flat) } };
      },
      createCommit: async (p: {
        owner: string;
        repo: string;
        message: string;
        tree: string;
        parents: string[];
      }) => {
        this.calls.push("git.createCommit");
        const sha = this.sha();
        this.repo(p.owner, p.repo).commits.set(sha, {
          tree: p.tree,
          parents: p.parents,
          message: p.message,
        });
        return { data: { sha } };
      },
      createRef: async (p: { owner: string; repo: string; ref: string; sha: string }) => {
        this.calls.push("git.createRef");
        const r = this.repo(p.owner, p.repo);
        const name = p.ref.replace(/^refs\/heads\//, "");
        if (r.refs.has(name)) throw httpError(422, "Reference already exists");
        r.refs.set(name, p.sha);
        return { data: {} };
      },
      updateRef: async (p: { owner: string; repo: string; ref: string; sha: string; force?: boolean }) => {
        this.calls.push("git.updateRef");
        const r = this.repo(p.owner, p.repo);
        const name = p.ref.replace(/^heads\//, "");
        if (!r.refs.has(name)) throw httpError(422, "Reference does not exist");
        r.refs.set(name, p.sha);
        return { data: {} };
      },
      deleteRef: async (p: { owner: string; repo: string; ref: string }) => {
        this.calls.push("git.deleteRef");
        this.repo(p.owner, p.repo).refs.delete(p.ref.replace(/^heads\//, ""));
        return { data: {} };
      },
    },

    pulls: {
      list: async (p: { owner: string; repo: string; head?: string; state?: string }) => {
        const r = this.repo(p.owner, p.repo);
        const data = r.pulls.filter((pr) => {
          if (p.state && p.state !== "all" && pr.state !== p.state) return false;
          if (p.head) {
            const [headOwner, ref] = p.head.split(":");
            if (pr.head.ref !== ref) return false;
            if (!pr.head.repo?.full_name.toLowerCase().startsWith(`${headOwner.toLowerCase()}/`)) {
              return false;
            }
          }
          return true;
        });
        return { data };
      },
      create: async (p: {
        owner: string;
        repo: string;
        head: string;
        base: string;
        title: string;
        body: string;
      }) => {
        this.calls.push("pulls.create");
        if (this.failNextPullCreate) {
          const err = this.failNextPullCreate;
          this.failNextPullCreate = null;
          throw err;
        }
        const r = this.repo(p.owner, p.repo);
        if (!r.refs.has(p.head)) throw httpError(422, "head does not exist");
        const number = this.next++;
        const pr: FakePr = {
          number,
          state: "open",
          merged_at: null,
          html_url: `https://github.com/${r.fullName}/pull/${number}`,
          title: p.title,
          body: p.body,
          base: p.base,
          head: { ref: p.head, repo: { full_name: r.fullName } },
          reviewers: [],
        };
        r.pulls.push(pr);
        return { data: { number, html_url: pr.html_url } };
      },
      update: async (p: { owner: string; repo: string; pull_number: number; state: "open" | "closed" }) => {
        this.calls.push("pulls.update");
        const pr = this.repo(p.owner, p.repo).pulls.find((x) => x.number === p.pull_number)!;
        pr.state = p.state;
        return { data: {} };
      },
      requestReviewers: async (p: { owner: string; repo: string; pull_number: number; reviewers: string[] }) => {
        const pr = this.repo(p.owner, p.repo).pulls.find((x) => x.number === p.pull_number)!;
        pr.reviewers.push(...p.reviewers);
        return { data: {} };
      },
    },

    issues: {
      createComment: async (p: { owner: string; repo: string; issue_number: number; body: string }) => {
        this.calls.push("issues.createComment");
        const r = this.repo(p.owner, p.repo);
        const issue = r.issues.find((i) => i.number === p.issue_number);
        if (issue) issue.comments.push(p.body);
        else {
          const pr = r.pulls.find((x) => x.number === p.issue_number);
          if (!pr) throw httpError(404, "Not Found");
          (pr as FakePr & { comments?: string[] }).comments ??= [];
          (pr as FakePr & { comments?: string[] }).comments!.push(p.body);
        }
        return { data: {} };
      },
      listForRepo: async (p: { owner: string; repo: string; state?: string; labels?: string }) => {
        const r = this.repo(p.owner, p.repo);
        const data = r.issues
          .filter((i) => !p.state || p.state === "all" || i.state === p.state)
          .filter((i) => !p.labels || p.labels.split(",").every((l) => i.labels.includes(l)))
          .map((i) => ({ number: i.number, title: i.title, body: i.body, pull_request: undefined }));
        return { data };
      },
      listComments: async (p: { owner: string; repo: string; issue_number: number }) => {
        const issue = this.repo(p.owner, p.repo).issues.find((i) => i.number === p.issue_number)!;
        return { data: issue.comments.map((body) => ({ body })) };
      },
      create: async (p: { owner: string; repo: string; title: string; body: string; labels?: string[] }) => {
        this.calls.push("issues.create");
        const r = this.repo(p.owner, p.repo);
        const number = this.next++;
        r.issues.push({
          number,
          title: p.title,
          body: p.body,
          labels: p.labels ?? [],
          state: "open",
          comments: [],
        });
        return { data: { number } };
      },
    },
  };

  asOctokit(): Octokit {
    return this.octokit as unknown as Octokit;
  }
}
