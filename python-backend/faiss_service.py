import os
import pickle
import faiss
import numpy as np
from typing import List, Tuple
from dotenv import load_dotenv

load_dotenv()

# Paths from .env
INDEX_PATH   = os.getenv("FAISS_INDEX_PATH",   "faiss/article.index")
MAPPING_PATH = os.getenv("FAISS_MAPPING_PATH", "faiss/article_mapping.pkl")

# all-MiniLM-L6-v2 produces 384-dimensional vectors
DIMENSION = 384

# Global in-memory state
faiss_index = None       # FAISS index object
id_map: dict = {}        # { faiss_id (int) : mongo_id (str) }


def load_or_create_index():
    """
    Load FAISS index and id_map from disk if they exist.
    Otherwise create a fresh empty index.

    Called once at FastAPI startup in main.py
    """
    global faiss_index, id_map

    if os.path.exists(INDEX_PATH) and os.path.exists(MAPPING_PATH):
        faiss_index = faiss.read_index(INDEX_PATH)
        with open(MAPPING_PATH, "rb") as f:
            id_map = pickle.load(f)
        print(f"[faiss] Loaded index — {faiss_index.ntotal} vectors")
    else:
        # IndexFlatIP = exact inner product search
        # On unit-normalized vectors, inner product == cosine similarity
        faiss_index = faiss.IndexFlatIP(DIMENSION)
        id_map = {}
        print("[faiss] Created new empty index")


def save_index():
    """
    Save FAISS index and id_map to disk.
    Called after every ingestion batch so progress survives restarts.
    """
    os.makedirs(os.path.dirname(INDEX_PATH), exist_ok=True)
    faiss.write_index(faiss_index, INDEX_PATH)
    with open(MAPPING_PATH, "wb") as f:
        pickle.dump(id_map, f)


def add_articles(mongo_ids: List[str], vectors: np.ndarray) -> int:
    """
    Add a batch of article vectors to the FAISS index.

    RECEIVES : mongo_ids — list of MongoDB ObjectId strings, one per vector
               vectors   — numpy array shape (N, 384), float32, unit-normalized
    RETURNS  : start_faiss_id — the first integer id assigned by FAISS
                                (subsequent ids are start+1, start+2, ...)

    The caller (xml_loader.py) uses start_faiss_id to update
    Article.faissId in MongoDB for each article in the batch.

    Called by : xml_loader.py during ingestion
    """
    global faiss_index, id_map

    start_id = faiss_index.ntotal      # next available integer id

    faiss_index.add(vectors)           # assigns ids: start_id, start_id+1, ...

    # Store mapping faiss_id → mongo_id
    for i, mongo_id in enumerate(mongo_ids):
        id_map[start_id + i] = mongo_id

    save_index()

    return start_id


def search(
    profile_vector: List[float],
    top_k: int = 20
) -> Tuple[List[int], List[float]]:
    """
    Search the index for the top_k most similar articles to a profile vector.

    RECEIVES : profile_vector — 384-dim float list (from User.profileEmbedding)
               top_k          — number of results to return
    RETURNS  : (faiss_ids, scores) — both lists, ordered best-first

    Called by : recommendation.py → get_recommendations
    """
    if faiss_index.ntotal == 0:
        return [], []

    # FAISS expects a 2D array: (num_queries, dimension)
    query = np.array([profile_vector], dtype="float32")

    scores, indices = faiss_index.search(query, top_k)

    # Flatten from shape (1, top_k) to plain lists
    faiss_ids = indices[0].tolist()
    sim_scores = scores[0].tolist()

    # FAISS returns -1 when there are fewer results than top_k
    results = [
        (fid, score)
        for fid, score in zip(faiss_ids, sim_scores)
        if fid != -1
    ]

    if not results:
        return [], []

    ids, scores_out = zip(*results)
    return list(ids), list(scores_out)


def search_similar(
    faiss_id: int,
    top_k: int = 10
) -> Tuple[List[int], List[float]]:
    """
    Find articles similar to a given article by reconstructing its vector.

    RECEIVES : faiss_id — the integer id stored in Article.faissId
               top_k    — number of similar articles to return
    RETURNS  : (faiss_ids, scores) — excludes the source article itself

    Called by : recommendation.py → get_similar_articles
    """
    if faiss_index.ntotal == 0:
        return [], []

    # Reconstruct the vector stored at this position in the index
    vector = faiss_index.reconstruct(faiss_id)             # shape (384,)
    query  = np.array([vector], dtype="float32")           # shape (1, 384)

    # Fetch one extra so we can drop the source article from results
    scores, indices = faiss_index.search(query, top_k + 1)

    results = [
        (int(idx), float(score))
        for idx, score in zip(indices[0], scores[0])
        if idx != -1 and int(idx) != faiss_id
    ]

    results = results[:top_k]

    if not results:
        return [], []

    ids, scores_out = zip(*results)
    return list(ids), list(scores_out)


def get_mongo_id(faiss_id: int) -> str:
    """Look up one MongoDB ObjectId string by FAISS id."""
    return id_map.get(faiss_id)


def get_mongo_ids(faiss_ids: List[int]) -> List[str]:
    """Bulk look up MongoDB ObjectId strings for a list of FAISS ids."""
    return [id_map[fid] for fid in faiss_ids if fid in id_map]


def total_vectors() -> int:
    """Return how many vectors are currently in the index."""
    return faiss_index.ntotal if faiss_index else 0