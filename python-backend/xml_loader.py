import os
import glob
import math
import xml.etree.ElementTree as ET
from pymongo import MongoClient
from bson import ObjectId
from dotenv import load_dotenv

import embedding
import faiss_service

load_dotenv()

# MongoDB connection
mongo  = MongoClient(os.getenv("MONGO_URI"))
db     = mongo[os.getenv("MONGO_DB_NAME", "article_platform")]


def parse_xml(filepath: str) -> dict | None:
    """
    Parse one XML file into an article dict.

    Expected XML shape (all tags optional except title + body):
    <article>
        <title>...</title>
        <body>...</body>
        <summary>...</summary>
        <author>...</author>
        <source>...</source>
        <source_url>...</source_url>
        <image_url>...</image_url>
        <published_at>2024-01-15</published_at>
        <topics>
            <topic>AI</topic>
            <topic>Machine Learning</topic>
        </topics>
    </article>

    RETURNS : article dict or None if the file is invalid / missing title+body
    """
    try:
        tree = ET.parse(filepath)
        root = tree.getroot()

        # Helper: safely get text from a tag, return "" if missing
        def get(tag: str) -> str:
            el = root.find(tag)
            return el.text.strip() if el is not None and el.text else ""

        title = get("title")
        body  = get("body")

        # Skip articles with no content
        if not title or not body:
            return None

        # Parse topics list
        topics_el = root.find("topics")
        topics = []
        if topics_el is not None:
            topics = [t.text.strip() for t in topics_el.findall("topic") if t.text]

        # Estimate reading time (average adult reads ~238 words/min)
        word_count = len(body.split())
        read_time  = max(1, math.ceil(word_count / 238))

        # Use first 250 chars of body as summary if no explicit summary tag
        summary = get("summary") or body[:250]

        return {
            "title":         title,
            "body":          body,
            "summary":       summary,
            "author":        get("author") or "Unknown",
            "source":        get("source"),
            "sourceUrl":     get("source_url") or None,
            "imageUrl":      get("image_url") or None,
            "topics":        topics,
            "readTimeMin":   read_time,
            "publishedAt":   get("published_at") or None,
            "xmlSourcePath": filepath,
            "isIndexed":     False,
            "faissId":       None,
            "likeCount":     0,
            "bookmarkCount": 0,
            "commentCount":  0,
            "shareCount":    0,
        }
    except Exception as e:
        print(f"[xml_loader] Parse error — {filepath}: {e}")
        return None


def run_ingestion(xml_dir: str = "E:/wikiData", batch_size: int = 100) -> dict:
    """
    Full ingestion pipeline — reads all XML files from xml_dir and
    loads them into MongoDB + FAISS index.

    Flow per batch:
      1. Parse XML files into article dicts
      2. Upsert into MongoDB (safe to re-run — skips existing articles)
      3. Generate 384-dim embeddings for the batch
      4. Add vectors to FAISS index → get faiss_ids back
      5. Write faissId + isIndexed=True back to MongoDB

    RECEIVES : xml_dir    — folder containing .xml files (searched recursively)
               batch_size — articles to process per iteration
    RETURNS  : summary dict with counts

    Called by : main.py → POST /ingest
    """
    # Find all XML files recursively
    xml_files = glob.glob(os.path.join(xml_dir, "**", "*.xml"), recursive=True)
    total     = len(xml_files)
    print(f"[xml_loader] Found {total} XML files in '{xml_dir}'")

    inserted = 0
    indexed  = 0
    failed   = 0

    for i in range(0, total, batch_size):
        batch_files = xml_files[i : i + batch_size]

        # ── Step 1: Parse XML ─────────────────────────────────────────────────
        articles = []
        for filepath in batch_files:
            article = parse_xml(filepath)
            if article:
                articles.append(article)
            else:
                failed += 1

        if not articles:
            continue

        # ── Step 2: Upsert into MongoDB ───────────────────────────────────────
        # Use upsert so re-running ingestion never creates duplicates
        to_embed = []   # (mongo_id_str, article) pairs that need FAISS indexing

        for article in articles:
            try:
                # Dedup key: sourceUrl if available, else xmlSourcePath
                dedup_key = (
                    {"sourceUrl": article["sourceUrl"]}
                    if article["sourceUrl"]
                    else {"xmlSourcePath": article["xmlSourcePath"]}
                )

                result = db.articles.update_one(
                    dedup_key,
                    {"$setOnInsert": article},
                    upsert=True,
                )

                if result.upserted_id:
                    # New article inserted
                    to_embed.append((str(result.upserted_id), article))
                    inserted += 1
                else:
                    # Article already exists — check if it needs FAISS indexing
                    existing = db.articles.find_one(
                        dedup_key,
                        {"_id": 1, "isIndexed": 1}
                    )
                    if existing and not existing.get("isIndexed"):
                        to_embed.append((str(existing["_id"]), article))

            except Exception as e:
                print(f"[xml_loader] MongoDB error: {e}")
                failed += 1

        if not to_embed:
            continue

        # ── Step 3: Generate embeddings ───────────────────────────────────────
        # Concatenate title + first 500 chars of body for a richer signal
        texts = [
            f"{art['title']} {art['body'][:500]}"
            for _, art in to_embed
        ]

        try:
            vectors = embedding.encode_batch(texts)  # shape (N, 384), float32
        except Exception as e:
            print(f"[xml_loader] Embedding error: {e}")
            failed += len(to_embed)
            continue

        # ── Step 4: Add to FAISS ──────────────────────────────────────────────
        mongo_ids    = [mid for mid, _ in to_embed]
        start_faiss_id = faiss_service.add_articles(mongo_ids, vectors)

        # ── Step 5: Write faissId back to MongoDB ────────────────────────────
        for j, (mongo_id, _) in enumerate(to_embed):
            faiss_id = start_faiss_id + j
            db.articles.update_one(
                {"_id": ObjectId(mongo_id)},
                {"$set": {"faissId": faiss_id, "isIndexed": True}}
            )
            indexed += 1

        processed = min(i + batch_size, total)
        print(f"[xml_loader] {processed}/{total} files | "
              f"inserted: {inserted} | indexed: {indexed} | failed: {failed}")

    print(f"[xml_loader] Done — "
          f"total: {total} | inserted: {inserted} | indexed: {indexed} | failed: {failed}")

    return {
        "total_files": total,
        "inserted":    inserted,
        "indexed":     indexed,
        "failed":      failed,
        "message":     "Ingestion complete",
    }