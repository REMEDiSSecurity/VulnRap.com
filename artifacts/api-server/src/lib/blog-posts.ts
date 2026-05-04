import { existsSync, readFileSync } from "fs";
import path from "path";

const BLOG_POSTS_CANDIDATES = [
  process.env.BLOG_POSTS_PATH,
  path.resolve(process.cwd(), "data/blog-posts.json"),
  path.resolve(process.cwd(), "artifacts/api-server/data/blog-posts.json"),
].filter((p): p is string => !!p);

export interface BlogPostMeta {
  id: string;
  title: string;
  date: string;
  summary: string;
}

interface BlogPostsFile {
  version: number;
  updatedAt: string;
  posts: BlogPostMeta[];
}

function resolveBlogPostsPath(): string {
  for (const candidate of BLOG_POSTS_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `[blog] Could not find blog-posts.json. Tried: ${BLOG_POSTS_CANDIDATES.join(", ")}`,
  );
}

export function loadBlogPostsMeta(): BlogPostMeta[] {
  const raw = JSON.parse(
    readFileSync(resolveBlogPostsPath(), "utf8"),
  ) as BlogPostsFile;
  if (!raw || !Array.isArray(raw.posts)) {
    throw new Error("[blog] blog-posts.json is missing a `posts` array");
  }
  for (const post of raw.posts) {
    if (!post.id || !post.title || !post.date || !post.summary) {
      throw new Error(
        `[blog] blog-posts.json entry is missing required fields: ${JSON.stringify(post)}`,
      );
    }
    if (Number.isNaN(Date.parse(post.date))) {
      throw new Error(`[blog] Invalid date for post ${post.id}: ${post.date}`);
    }
  }
  return raw.posts;
}
