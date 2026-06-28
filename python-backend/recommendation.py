from typing import List, Dict, Tuple

import faiss_service
import embedding


def get_recommendations(
    profile_vector: List[float],
    top_k: int = 20,
    seen_faiss_ids: List[int] = []
) -> Tuple[List[int], List[float]]:
    """
    Return personalized article recommendations for a user.

    Flow:
      1. Search FAISS with the user's profile vector
      2. Filter out articles the user has already seen
      3. Return top_k results ranked by similarity score

    RECEIVES : profile_vector  — 384-dim list from User.profileEmbedding
               top_k           — how many articles to return
               seen_faiss_ids  — faiss ids to exclude (already viewed)
    RETURNS  : (faiss_ids, scores) ordered best-first

    Called by : main.py → /recommend route
    Node then fetches full article data from MongoDB using these faiss_ids
    """
    # Fetch extra results so we still have enough after filtering seen articles
    fetch_k = top_k + len(seen_faiss_ids) + 10

    faiss_ids, scores = faiss_service.search(profile_vector, top_k=fetch_k)

    if not faiss_ids:
        return [], []

    # Remove articles the user has already seen
    seen_set = set(seen_faiss_ids)
    filtered = [
        (fid, score)
        for fid, score in zip(faiss_ids, scores)
        if fid not in seen_set
    ]

    # Trim to the requested number
    filtered = filtered[:top_k]

    if not filtered:
        return [], []

    ids, scores_out = zip(*filtered)
    return list(ids), list(scores_out)


def rebuild_profile_vector(
    topics: List[str],
    topic_scores: Dict[str, float]
) -> List[float]:
    """
    Rebuild a user's profile embedding using their current topic scores.
    Topics with higher scores contribute more to the final vector.

    RECEIVES : topics       — list of topic strings e.g. ["AI", "Finance"]
               topic_scores — score map e.g. {"AI": 42.3, "Finance": 11.8}
    RETURNS  : 384-dim profile vector (list of floats)

    Called by : main.py → /profile/update and /profile/rebuild routes
    Node saves the returned vector to User.profileEmbedding
    """
    return embedding.build_profile_from_scores(topics, topic_scores)


def get_similar_articles(
    faiss_id: int,
    top_k: int = 10
) -> Tuple[List[int], List[float]]:
    """
    Find articles similar to a given article.

    RECEIVES : faiss_id — integer from Article.faissId
               top_k    — number of similar articles to return
    RETURNS  : (faiss_ids, scores) excluding the source article

    Called by : main.py → /faiss/similar route
    """
    return faiss_service.search_similar(faiss_id, top_k)