from pydantic import BaseModel
from typing import List


# ── Embedding ─────────────────────────────────────────────────────────────────

class EmbedTextResponse(BaseModel):
    # 384-dim vector for a single text
    vector: List[float]


class EmbedInterestsResponse(BaseModel):
    # Mean-pooled 384-dim profile vector from topic labels
    profile_vector: List[float]


# ── FAISS ─────────────────────────────────────────────────────────────────────

class FAISSSearchResponse(BaseModel):
    # FAISS integer ids ordered best-first, with their similarity scores
    faiss_ids: List[int]
    scores: List[float]


# ── Recommendation ────────────────────────────────────────────────────────────

class RecommendResponse(BaseModel):
    # Ranked FAISS ids — Node fetches full article data from MongoDB using these
    faiss_ids: List[int]
    scores: List[float]


# ── Profile ───────────────────────────────────────────────────────────────────

class ProfileUpdateResponse(BaseModel):
    # Rebuilt user profile vector — Node saves this to User.profileEmbedding
    profile_vector: List[float]
    message: str = "Profile updated"


# ── Ingestion ─────────────────────────────────────────────────────────────────

class IngestResponse(BaseModel):
    # Summary returned after XML ingestion completes
    total_files: int
    inserted: int
    indexed: int
    failed: int
    message: str


# ── Health ────────────────────────────────────────────────────────────────────

class HealthResponse(BaseModel):
    status: str
    faiss_total_vectors: int
    model_loaded: bool