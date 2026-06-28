from pydantic import BaseModel
from typing import List, Optional, Dict


# ── Embedding ─────────────────────────────────────────────────────────────────

class EmbedTextRequest(BaseModel):
    # A single search query to encode into a vector
    # Example: { "text": "machine learning tutorial" }
    text: str


class EmbedInterestsRequest(BaseModel):
    # Topic labels the user selected at signup
    # Example: { "topics": ["AI", "Finance", "Sports"] }
    topics: List[str]


# ── FAISS ─────────────────────────────────────────────────────────────────────

class FAISSSearchRequest(BaseModel):
    # Search FAISS using a user profile vector
    profile_vector: List[float]   # 384 floats
    top_k: int = 20


class FAISSSearchByIdRequest(BaseModel):
    # Find articles similar to a given article by its FAISS id
    faiss_id: int
    top_k: int = 10


# ── Recommendation ────────────────────────────────────────────────────────────

class RecommendRequest(BaseModel):
    # Full recommendation request — sent by Node feed controller
    profile_vector: List[float]             # 384 floats from User.profileEmbedding
    top_k: int = 20
    seen_faiss_ids: Optional[List[int]] = []  # already seen articles to exclude


# ── Profile ───────────────────────────────────────────────────────────────────

class ProfileUpdateRequest(BaseModel):
    # Rebuild user embedding after interaction batch updates topic scores
    user_id: str
    topics: List[str]                        # e.g. ["AI", "Finance"]
    topic_scores: Dict[str, float]           # e.g. {"AI": 42.3, "Finance": 11.8}


# ── Ingestion ─────────────────────────────────────────────────────────────────

class IngestRequest(BaseModel):
    # Trigger XML ingestion from a folder
    xml_dir: str = "E:/wikiData"
    batch_size: int = 100