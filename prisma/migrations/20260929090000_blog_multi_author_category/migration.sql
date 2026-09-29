-- Co-authors and additional categories for blog posts.
--
-- BlogPost.authorId and BlogPost.categoryId stay exactly as they are: the
-- PRIMARY of each. Every existing reader — the storefront byline, the author
-- pages, articleSection in the Article schema, the chatbot's blog search —
-- keeps working untouched, and there is still one unambiguous answer to
-- "which category owns this post". These tables carry the full sets, with
-- the primary present at position 0, so a byline can be rendered from one
-- table rather than by unioning a column with a list.

CREATE TABLE "blog_post_authors" (
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "blog_post_authors_pkey" PRIMARY KEY ("postId","authorId")
);

CREATE INDEX "blog_post_authors_authorId_idx" ON "blog_post_authors"("authorId");

ALTER TABLE "blog_post_authors"
    ADD CONSTRAINT "blog_post_authors_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "blog_posts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "blog_post_authors"
    ADD CONSTRAINT "blog_post_authors_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "blog_authors"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "blog_post_categories" (
    "postId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "blog_post_categories_pkey" PRIMARY KEY ("postId","categoryId")
);

CREATE INDEX "blog_post_categories_categoryId_idx" ON "blog_post_categories"("categoryId");

ALTER TABLE "blog_post_categories"
    ADD CONSTRAINT "blog_post_categories_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "blog_posts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "blog_post_categories"
    ADD CONSTRAINT "blog_post_categories_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "blog_categories"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing post's current author and category become its
-- first credited author and first category. ON CONFLICT so re-running this
-- against a partially-migrated database is harmless.
INSERT INTO "blog_post_authors" ("postId", "authorId", "position")
SELECT "id", "authorId", 0 FROM "blog_posts"
ON CONFLICT DO NOTHING;

INSERT INTO "blog_post_categories" ("postId", "categoryId", "position")
SELECT "id", "categoryId", 0 FROM "blog_posts" WHERE "categoryId" IS NOT NULL
ON CONFLICT DO NOTHING;
