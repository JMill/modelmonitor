import type { Octokit } from "@octokit/rest";

// A small in-memory GitHub covering exactly the REST calls pr-bumper.ts and
// alerts.ts make: repos, the git data API (blobs, trees, commits, refs),
// pulls and issues. Enough state to assert what a bump run leaves behind.
//
// It is as strict as GitHub where a mistake would only show up on the first
// real run:
//   - ref names: getRef / updateRef / deleteRef take `heads/<branch>` (no
//     leading `refs/`), createRef takes `refs/heads/<branch>`, and anything
//     else fails the way GitHub fails it (404 / 422);
//   - updateRef / deleteRef on a missing ref are a 422;
//   - a renamed repo resolves only for reads (writes must use the canonical
//     name repos.get returns), and the `owner:branch` head filter matches
//     the current owner exactly;
//   - a second open PR on the same head is a 422, and the PR's author can't
//     be requested as a reviewer;
//   - issues.listForRepo returns pull requests too, marked `pull_request`.

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
  user: { login: string };
  labels: string[];
  reviewers: string[];
  comments?: string[];
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

// The branch named by `ref` in the exact form an endpoint takes (`heads/x`
// for get/update/delete, `refs/heads/x` for create), or undefined.
const branchOf = (ref: string, form: "heads/" | "refs/heads/") =>
  ref.startsWith(form) && ref.length > form.length ? ref.slice(form.length) : undefined;

// A 422 shaped like Octokit's RequestError: the validation errors are folded
// into the message and kept on response.data.
const validationFailed = (error: Record<string, string>) =>
  Object.assign(new Error(`Validation Failed: ${JSON.stringify(error)}`), {
    status: 422,
    response: { data: { message: "Validation Failed", errors: [error] } },
  });

export class FakeGitHub {
  private repos = new Map<string, Repo>();
  // Old lower-cased full name -> current one, as after a rename or transfer.
  private redirects = new Map<string, string>();
  private seq = 0;
  private next = 1;
  // The token's owner: the author of every PR the bumper opens.
  author = "JMill";
  // Test hooks: make pulls.create throw once; run something just before it
  // (to simulate a PR opened between the bumper's lookup and its create).
  failNextPullCreate: Error | null = null;
  beforePullCreate: (() => void) | null = null;
  // Test hook: issues.create fails, as with a token that can't write issues.
  failIssueWrites = false;
  // Test hook: head-filtered pulls.list returns nothing, as if GitHub's
  // `owner:branch` matching missed the PR.
  headFilterMisses = false;
  calls: string[] = [];

  private sha(): string {
    return (++this.seq).toString(16).padStart(40, "0");
  }

  // `follow`: GET requests follow GitHub's redirect for a renamed or
  // transferred repo. Writes don't here, so code under test must use the
  // canonical name.
  private repo(owner: string, repo: string, follow = false): Repo {
    let key = `${owner}/${repo}`.toLowerCase();
    if (follow) key = this.redirects.get(key) ?? key;
    const r = this.repos.get(key);
    if (!r) throw httpError(404, `Not Found: ${owner}/${repo}`);
    return r;
  }

  renameRepo(from: string, to: string): void {
    const r = this.repos.get(from.toLowerCase())!;
    this.repos.delete(from.toLowerCase());
    r.fullName = to;
    for (const pr of r.pulls) {
      if (pr.head.repo?.full_name === from) pr.head.repo = { full_name: to };
    }
    this.repos.set(to.toLowerCase(), r);
    this.redirects.set(from.toLowerCase(), to.toLowerCase());
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

  // Seed a PR as if an earlier run (or a human) had opened it. `headRepo`
  // seeds a PR from a fork, whose branch lives outside this repo.
  addPull(
    fullName: string,
    pr: {
      ref: string;
      state?: "open" | "closed";
      merged?: boolean;
      createBranch?: boolean;
      headRepo?: string;
      body?: string;
      title?: string;
      labels?: string[];
    },
  ): FakePr {
    const r = this.repos.get(fullName.toLowerCase())!;
    const fork = pr.headRepo !== undefined && pr.headRepo !== r.fullName;
    if (!fork && (pr.createBranch ?? true)) {
      r.refs.set(pr.ref, this.commitOnDefault(r, `human work on ${pr.ref}`));
    }
    const number = this.next++;
    const created: FakePr = {
      number,
      state: pr.state ?? "open",
      merged_at: pr.merged ? "2026-09-01T00:00:00Z" : null,
      html_url: `https://github.com/${r.fullName}/pull/${number}`,
      title: pr.title ?? `seeded ${pr.ref}`,
      body: pr.body ?? "",
      base: r.defaultBranch,
      head: { ref: pr.ref, repo: { full_name: pr.headRepo ?? r.fullName } },
      user: { login: "someone" },
      labels: pr.labels ?? [],
      reviewers: [],
    };
    r.pulls.push(created);
    return created;
  }

  // A commit on top of the default branch, standing in for work pushed to a
  // PR branch, so tests can tell whether that work survived a run.
  private commitOnDefault(r: Repo, message: string): string {
    const head = r.refs.get(r.defaultBranch)!;
    const sha = this.sha();
    r.commits.set(sha, { ...r.commits.get(head)!, parents: [head], message });
    return sha;
  }

  // Octokit surface --------------------------------------------------------

  readonly octokit = {
    paginate: async <P, T>(fn: (p: P) => Promise<{ data: T[] }>, params: P): Promise<T[]> =>
      (await fn(params)).data,

    repos: {
      get: async ({ owner, repo }: { owner: string; repo: string }) => {
        this.calls.push("repos.get");
        const r = this.repo(owner, repo, true);
        const [login, name] = r.fullName.split("/");
        return {
          data: { default_branch: r.defaultBranch, full_name: r.fullName, name, owner: { login } },
        };
      },
    },

    git: {
      getRef: async ({ owner, repo, ref }: { owner: string; repo: string; ref: string }) => {
        const r = this.repo(owner, repo, true);
        const sha = r.refs.get(branchOf(ref, "heads/") ?? "\0");
        if (!sha) throw httpError(404, "Not Found");
        return { data: { object: { sha } } };
      },
      getCommit: async (p: { owner: string; repo: string; commit_sha: string }) => {
        const c = this.repo(p.owner, p.repo, true).commits.get(p.commit_sha);
        if (!c) throw httpError(404, "Not Found");
        return { data: { tree: { sha: c.tree } } };
      },
      getTree: async (p: { owner: string; repo: string; tree_sha: string }) => {
        const t = this.repo(p.owner, p.repo, true).trees.get(p.tree_sha);
        if (!t) throw httpError(404, "Not Found");
        return { data: { tree: t.map((e) => ({ ...e })) } };
      },
      getBlob: async (p: { owner: string; repo: string; file_sha: string }) => {
        const b = this.repo(p.owner, p.repo, true).blobs.get(p.file_sha);
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
        const name = branchOf(p.ref, "refs/heads/");
        if (!name) throw httpError(422, `Reference name must start with 'refs/heads/': ${p.ref}`);
        if (r.refs.has(name)) throw httpError(422, "Reference already exists");
        if (!r.commits.has(p.sha)) throw httpError(422, "Object does not exist");
        r.refs.set(name, p.sha);
        return { data: {} };
      },
      updateRef: async (p: { owner: string; repo: string; ref: string; sha: string; force?: boolean }) => {
        this.calls.push("git.updateRef");
        const r = this.repo(p.owner, p.repo);
        const name = branchOf(p.ref, "heads/");
        if (!name || !r.refs.has(name)) throw httpError(422, "Reference does not exist");
        if (!r.commits.has(p.sha)) throw httpError(422, "Object does not exist");
        r.refs.set(name, p.sha);
        return { data: {} };
      },
      deleteRef: async (p: { owner: string; repo: string; ref: string }) => {
        this.calls.push("git.deleteRef");
        const r = this.repo(p.owner, p.repo);
        const name = branchOf(p.ref, "heads/");
        if (!name || !r.refs.has(name)) throw httpError(422, "Reference does not exist");
        r.refs.delete(name);
        return { data: {} };
      },
    },

    pulls: {
      list: async (p: { owner: string; repo: string; head?: string; state?: string }) => {
        const r = this.repo(p.owner, p.repo, true);
        const data = r.pulls.filter((pr) => {
          if (p.state && p.state !== "all" && pr.state !== p.state) return false;
          if (p.head) {
            if (this.headFilterMisses) return false;
            // The label is `<current owner login>:<ref>`: an old owner name
            // (or different casing of it) matches nothing.
            const [headOwner, ref] = p.head.split(":");
            if (pr.head.ref !== ref) return false;
            if (pr.head.repo?.full_name.split("/")[0] !== headOwner) return false;
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
        this.beforePullCreate?.();
        this.beforePullCreate = null;
        if (this.failNextPullCreate) {
          const err = this.failNextPullCreate;
          this.failNextPullCreate = null;
          throw err;
        }
        const r = this.repo(p.owner, p.repo);
        const [login] = r.fullName.split("/");
        const head = p.head.includes(":") ? p.head : `${login}:${p.head}`;
        const [headOwner, ref] = head.split(":");
        if (headOwner !== login || !r.refs.has(ref)) {
          throw validationFailed({ field: "head", code: "invalid", resource: "PullRequest" });
        }
        const dup = r.pulls.find(
          (x) => x.state === "open" && x.head.ref === ref && x.head.repo?.full_name === r.fullName,
        );
        if (dup) {
          throw validationFailed({
            resource: "PullRequest",
            code: "custom",
            message: `A pull request already exists for ${head}.`,
          });
        }
        const number = this.next++;
        const pr: FakePr = {
          number,
          state: "open",
          merged_at: null,
          html_url: `https://github.com/${r.fullName}/pull/${number}`,
          title: p.title,
          body: p.body,
          base: p.base,
          head: { ref, repo: { full_name: r.fullName } },
          user: { login: this.author },
          labels: [],
          reviewers: [],
        };
        r.pulls.push(pr);
        return { data: { number, html_url: pr.html_url, user: pr.user } };
      },
      update: async (p: {
        owner: string;
        repo: string;
        pull_number: number;
        state?: "open" | "closed";
        body?: string;
      }) => {
        this.calls.push("pulls.update");
        const pr = this.repo(p.owner, p.repo).pulls.find((x) => x.number === p.pull_number)!;
        if (p.state) pr.state = p.state;
        if (p.body !== undefined) pr.body = p.body;
        return { data: {} };
      },
      requestReviewers: async (p: { owner: string; repo: string; pull_number: number; reviewers: string[] }) => {
        this.calls.push("pulls.requestReviewers");
        const pr = this.repo(p.owner, p.repo).pulls.find((x) => x.number === p.pull_number)!;
        // GitHub fails the whole request, not just the author's entry.
        if (p.reviewers.some((r) => r.toLowerCase() === pr.user.login.toLowerCase())) {
          throw httpError(422, "Review cannot be requested from pull request author.");
        }
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
          (pr.comments ??= []).push(p.body);
        }
        return { data: {} };
      },
      // Like GitHub's, this lists pull requests too (marked `pull_request`),
      // newest first.
      listForRepo: async (p: { owner: string; repo: string; state?: string; labels?: string }) => {
        const r = this.repo(p.owner, p.repo, true);
        const rows = [
          ...r.issues.map((i) => ({ ...i, pull_request: undefined })),
          ...r.pulls.map((pr) => ({
            number: pr.number,
            title: pr.title,
            body: pr.body,
            labels: pr.labels,
            state: pr.state,
            pull_request: { url: pr.html_url },
          })),
        ];
        const data = rows
          .filter((i) => !p.state || p.state === "all" || i.state === p.state)
          .filter((i) => !p.labels || p.labels.split(",").every((l) => i.labels.includes(l)))
          .sort((a, b) => b.number - a.number)
          .map(({ number, title, body, pull_request }) => ({ number, title, body, pull_request }));
        return { data };
      },
      listComments: async (p: { owner: string; repo: string; issue_number: number }) => {
        const r = this.repo(p.owner, p.repo, true);
        const thread =
          r.issues.find((i) => i.number === p.issue_number)?.comments ??
          r.pulls.find((x) => x.number === p.issue_number)?.comments;
        if (!thread && !r.pulls.some((x) => x.number === p.issue_number)) {
          throw httpError(404, "Not Found");
        }
        return { data: (thread ?? []).map((body) => ({ body })) };
      },
      update: async (p: {
        owner: string;
        repo: string;
        issue_number: number;
        state?: "open" | "closed";
        state_reason?: string;
      }) => {
        this.calls.push("issues.update");
        const issue = this.repo(p.owner, p.repo).issues.find((i) => i.number === p.issue_number);
        if (!issue) throw httpError(404, "Not Found");
        if (p.state) issue.state = p.state;
        return { data: {} };
      },
      create: async (p: { owner: string; repo: string; title: string; body: string; labels?: string[] }) => {
        this.calls.push("issues.create");
        if (this.failIssueWrites) throw httpError(403, "Resource not accessible by integration");
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
