import os
import numpy as np
from typing import List
from sentence_transformers import SentenceTransformer
from dotenv import load_dotenv

load_dotenv()

# Load model once at startup — stays in memory for all requests
# Downloads automatically on first run (~80MB)
MODEL_NAME = os.getenv("MODEL_NAME", "all-MiniLM-L6-v2")
model = SentenceTransformer(MODEL_NAME)

print(f"[embedding] Model '{MODEL_NAME}' loaded")


def encode_text(text: str) -> List[float]:
    """
    Encode a single text string into a 384-dim unit-normalized vector.

    RECEIVES : plain text string (e.g. a search query)
    RETURNS  : list of 384 floats

    Used by  : /embed/text route (article search)
    """
    vector = model.encode(text, normalize_embeddings=True)
    return vector.tolist()


def encode_batch(texts: List[str]) -> np.ndarray:
    """
    Encode a list of texts into a (N, 384) float32 array.

    RECEIVES : list of strings
    RETURNS  : numpy array shape (N, 384), float32, unit-normalized

    Used by  : xml_loader.py during ingestion to embed articles in bulk
    """
    vectors = model.encode(
        texts,
        normalize_embeddings=True,
        batch_size=64,           # process 64 texts at a time to fit in memory
        show_progress_bar=False,
    )
    return vectors.astype("float32")


def encode_interests(topics: List[str]) -> List[float]:
    """
    Encode topic labels and mean-pool them into one profile vector.

    RECEIVES : list of topic strings e.g. ["AI", "Finance", "Sports"]
    RETURNS  : list of 384 floats (single profile vector)

    Used by  : /embed/interests route — called right after user signup
    """
    # Encode each topic separately so each label gets full model attention
    vectors = model.encode(topics, normalize_embeddings=True)  # shape (N, 384)

    # Average all topic vectors into one
    profile = vectors.mean(axis=0)

    # Re-normalize so the vector sits on the unit sphere
    # Required for cosine similarity to work correctly with FAISS IndexFlatIP
    norm = np.linalg.norm(profile)
    if norm > 0:
        profile = profile / norm

    return profile.tolist()


def build_profile_from_scores(
    topics: List[str],
    topic_scores: dict
) -> List[float]:
    """
    Build a weighted profile vector using topic scores as weights.
    Topics with higher scores pull the final vector in their direction more.

    RECEIVES : topics       — list of topic strings
               topic_scores — dict e.g. {"AI": 42.3, "Finance": 11.8}
    RETURNS  : list of 384 floats

    Used by  : /profile/update and /profile/rebuild routes
               Called after every interaction batch updates topic scores
    """
    if not topics:
        return []

    vectors = model.encode(topics, normalize_embeddings=True)  # shape (N, 384)

    # Use topic scores as weights (default 1.0 for topics with no score yet)
    weights = np.array(
        [max(topic_scores.get(t, 1.0), 0.01) for t in topics],
        dtype="float32"
    )

    # Weighted average of topic vectors
    weighted = np.average(vectors, axis=0, weights=weights)

    # Re-normalize
    norm = np.linalg.norm(weighted)
    if norm > 0:
        weighted = weighted / norm

    return weighted.tolist()