from fastapi import FastAPI, HTTPException
from dotenv import load_dotenv
import os

load_dotenv()

import faiss_service
import embedding
import recommendation
import xml_loader

from models.request_models import (
    EmbedTextRequest,
    EmbedInterestsRequest,
    FAISSSearchRequest,
    FAISSSearchByIdRequest,
    RecommendRequest,
    ProfileUpdateRequest,
    IngestRequest,
)
from models.response_models import (
    EmbedTextResponse,
    EmbedInterestsResponse,
    FAISSSearchResponse,
    RecommendResponse,
    ProfileUpdateResponse,
    IngestResponse,
    HealthResponse,
)

app = FastAPI(title="Article Recommendation API", version="1.0.0")


# ── Startup ───────────────────────────────────────────────────────────────────

@app.on_event("startup")
def startup():
    # Load FAISS index from disk (creates empty index if first run)
    faiss_service.load_or_create_index()
    print("[main] FastAPI server ready")


# ── Health ────────────────────────────────────────────────────────────────────

# GET /health
# Used by Node pythonClient.js to check if the service is up
# RETURNS: { status, faiss_total_vectors, model_loaded }
@app.get("/health", response_model=HealthResponse)
def health():
    return {
        "status":              "ok",
        "faiss_total_vectors": faiss_service.total_vectors(),
        "model_loaded":        True,
    }


# ── Embedding routes ──────────────────────────────────────────────────────────

# POST /embed/text
# RECEIVES: { "text": "machine learning tutorial" }
# RETURNS:  { "vector": [...384 floats] }
# Used by:  article search — Node encodes the query then passes it to /faiss/search
@app.post("/embed/text", response_model=EmbedTextResponse)
def embed_text(body: EmbedTextRequest):
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="text cannot be empty")
    vector = embedding.encode_text(body.text)
    return {"vector": vector}


# POST /embed/interests
# RECEIVES: { "topics": ["AI", "Finance", "Sports"] }
# RETURNS:  { "profile_vector": [...384 floats] }
# Used by:  user.controller.js → setInterests (called right after signup)
@app.post("/embed/interests", response_model=EmbedInterestsResponse)
def embed_interests(body: EmbedInterestsRequest):
    if not body.topics:
        raise HTTPException(status_code=400, detail="topics list cannot be empty")
    profile_vector = embedding.encode_interests(body.topics)
    return {"profile_vector": profile_vector}


# ── FAISS routes ──────────────────────────────────────────────────────────────

# POST /faiss/search
# RECEIVES: { "profile_vector": [...384 floats], "top_k": 20 }
# RETURNS:  { "faiss_ids": [...], "scores": [...] }
# Used by:  feed.controller.js → getFeed
@app.post("/faiss/search", response_model=FAISSSearchResponse)
def faiss_search(body: FAISSSearchRequest):
    if len(body.profile_vector) != 384:
        raise HTTPException(status_code=400, detail="profile_vector must have 384 values")
    faiss_ids, scores = faiss_service.search(body.profile_vector, top_k=body.top_k)
    return {"faiss_ids": faiss_ids, "scores": scores}


# POST /faiss/similar
# RECEIVES: { "faiss_id": 42, "top_k": 10 }
# RETURNS:  { "faiss_ids": [...], "scores": [...] }
# Used by:  article.controller.js → getSimilarArticles
@app.post("/faiss/similar", response_model=FAISSSearchResponse)
def faiss_similar(body: FAISSSearchByIdRequest):
    if body.faiss_id >= faiss_service.total_vectors():
        raise HTTPException(status_code=404, detail="faiss_id not found in index")
    faiss_ids, scores = faiss_service.search_similar(body.faiss_id, top_k=body.top_k)
    return {"faiss_ids": faiss_ids, "scores": scores}


# ── Recommendation routes ─────────────────────────────────────────────────────

# POST /recommend
# RECEIVES: { "profile_vector": [...384 floats], "top_k": 20, "seen_faiss_ids": [...] }
# RETURNS:  { "faiss_ids": [...], "scores": [...] }
# Used by:  feed.controller.js → getFeed
#           recommendation.controller.js → getRecommendations
@app.post("/recommend", response_model=RecommendResponse)
def recommend(body: RecommendRequest):
    if len(body.profile_vector) != 384:
        raise HTTPException(status_code=400, detail="profile_vector must have 384 values")
    faiss_ids, scores = recommendation.get_recommendations(
        profile_vector = body.profile_vector,
        top_k          = body.top_k,
        seen_faiss_ids = body.seen_faiss_ids or [],
    )
    return {"faiss_ids": faiss_ids, "scores": scores}


# ── Profile routes ────────────────────────────────────────────────────────────

# POST /profile/update
# RECEIVES: { "user_id": "...", "topics": [...], "topic_scores": {"AI": 42.3} }
# RETURNS:  { "profile_vector": [...384 floats], "message": "Profile updated" }
# Used by:  interaction.controller.js → after processing a batch flush
@app.post("/profile/update", response_model=ProfileUpdateResponse)
def update_profile(body: ProfileUpdateRequest):
    profile_vector = recommendation.rebuild_profile_vector(
        topics       = body.topics,
        topic_scores = body.topic_scores,
    )
    if not profile_vector:
        raise HTTPException(status_code=400, detail="Could not build profile vector")
    return {"profile_vector": profile_vector, "message": "Profile updated"}


# POST /profile/rebuild
# Same as /profile/update — used by recommendation.controller.js → refreshEmbedding
@app.post("/profile/rebuild", response_model=ProfileUpdateResponse)
def rebuild_profile(body: ProfileUpdateRequest):
    return update_profile(body)


# ── Ingestion route ───────────────────────────────────────────────────────────

# POST /ingest
# RECEIVES: { "xml_dir": "E:/wikiData", "batch_size": 100 }
# RETURNS:  { "total_files": N, "inserted": N, "indexed": N, "failed": N, "message": "..." }
# Used by:  admin.controller.js or run manually once to load 200K articles
@app.post("/ingest", response_model=IngestResponse)
def ingest(body: IngestRequest):
    result = xml_loader.run_ingestion(
        xml_dir    = body.xml_dir,
        batch_size = body.batch_size,
    )
    return result


# ── Run directly ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host   = os.getenv("HOST", "0.0.0.0"),
        port   = int(os.getenv("PORT", 8000)),
        reload = True,
    )