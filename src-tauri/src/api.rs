use serde_json::{json, Value};

pub const GRAPHQL_URL: &str = "https://zvuk.com/api/v1/graphql";
pub const TINY_URL: &str = "https://zvuk.com/api/tiny";

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

#[derive(Debug)]
pub enum ApiError {
    Http(reqwest::Error),
    NotAuthorized,
    Graphql(Vec<String>),
    Other(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Http(e) => write!(f, "Сетевая ошибка: {e}"),
            ApiError::NotAuthorized => write!(f, "Токен недействителен или истёк"),
            ApiError::Graphql(errs) => write!(f, "Ошибка API: {}", errs.join("; ")),
            ApiError::Other(s) => write!(f, "{s}"),
        }
    }
}

impl std::error::Error for ApiError {}

impl From<reqwest::Error> for ApiError {
    fn from(e: reqwest::Error) -> Self {
        ApiError::Http(e)
    }
}

#[derive(Clone)]
pub struct ZvukApi {
    http: reqwest::Client,
    token: String,
}

impl ZvukApi {
    pub fn new(token: String) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .cookie_store(true)
            .build()
            .expect("failed to build http client");
        ZvukApi { http, token }
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub async fn anonymous_token() -> Result<String, ApiError> {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .cookie_store(true)
            .build()
            .expect("failed to build http client");
        let resp = http.get(format!("{TINY_URL}/profile")).send().await?;
        let status = resp.status();
        let body: Value = resp.json().await?;
        match body
            .get("result")
            .and_then(|r| r.get("token"))
            .and_then(|t| t.as_str())
            .map(str::to_string)
        {
            Some(token) => Ok(token),
            None => Err(ApiError::Other(format!(
                "Не удалось получить анонимный токен (HTTP {status})"
            ))),
        }
    }

    async fn gql(
        &self,
        query: &str,
        operation_name: &str,
        variables: Value,
    ) -> Result<Value, ApiError> {
        let payload = json!({
            "query": query,
            "operationName": operation_name,
            "variables": variables,
        });
        let resp = self
            .http
            .post(GRAPHQL_URL)
            .header("X-Auth-Token", &self.token)
            .header("Accept", "application/json")
            .json(&payload)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(ApiError::NotAuthorized);
        }
        let body: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => {
                return Err(ApiError::Other(
                    "Сервер вернул некорректный ответ (возможно, токен недействителен)".into(),
                ));
            }
        };
        if let Some(errors) = body.get("errors").and_then(|e| e.as_array()) {
            if !errors.is_empty() {
                let msgs: Vec<String> = errors
                    .iter()
                    .filter_map(|e| {
                        e.get("message")
                            .and_then(|m| m.as_str())
                            .map(str::to_string)
                    })
                    .collect();
                return Err(ApiError::Graphql(msgs));
            }
        }
        Ok(body.get("data").cloned().unwrap_or(Value::Null))
    }

    pub async fn quick_search(&self, query: &str, limit: u32) -> Result<Value, ApiError> {
        self.gql(
            QUICK_SEARCH,
            "GetSearch",
            json!({ "query": query, "limit": limit }),
        )
        .await
    }

    pub async fn search(&self, query: &str, limit: u32) -> Result<Value, ApiError> {
        self.gql(
            SEARCH_ALL,
            "GetSearchAll",
            json!({
                "query": query,
                "limit": limit,
                "tracks": true,
                "artists": true,
                "releases": true,
                "playlists": true,
            }),
        )
        .await
    }

    pub async fn stream(&self, ids: &[String]) -> Result<Value, ApiError> {
        self.gql(GET_STREAM, "GetStream", json!({ "ids": ids })).await
    }

    pub async fn tracks(&self, ids: &[String]) -> Result<Value, ApiError> {
        self.gql(GET_TRACKS, "GetTracks", json!({ "ids": ids })).await
    }

    pub async fn playlists(&self, ids: &[String]) -> Result<Value, ApiError> {
        self.gql(GET_PLAYLISTS, "GetPlaylists", json!({ "ids": ids }))
            .await
    }

    pub async fn releases(&self, ids: &[String], with_tracks: bool) -> Result<Value, ApiError> {
        self.gql(
            GET_RELEASES,
            "GetReleases",
            json!({ "ids": ids, "withTracks": with_tracks, "withArtists": false }),
        )
        .await
    }

    pub async fn user_collection(&self) -> Result<Value, ApiError> {
        self.gql(USER_COLLECTION, "userCollection", json!({})).await
    }

    pub async fn user_tracks(&self) -> Result<Value, ApiError> {
        self.gql(
            USER_TRACKS,
            "userTracks",
            json!({ "orderBy": "dateAdded", "orderDirection": "desc" }),
        )
        .await
    }

    pub async fn user_playlists(&self) -> Result<Value, ApiError> {
        self.gql(USER_PLAYLISTS, "userPlaylists", json!({})).await
    }

    pub async fn add_to_collection(&self, id: &str, item_type: &str) -> Result<Value, ApiError> {
        self.gql(
            ADD_ITEM,
            "addItemToCollection",
            json!({ "id": id, "type": item_type }),
        )
        .await
    }

    pub async fn remove_from_collection(
        &self,
        id: &str,
        item_type: &str,
    ) -> Result<Value, ApiError> {
        self.gql(
            REMOVE_ITEM,
            "removeItemFromCollection",
            json!({ "id": id, "type": item_type }),
        )
        .await
    }

    pub async fn verify(&self) -> Result<Value, ApiError> {
        match self.user_collection().await {
            Ok(v) => Ok(v),
            Err(_) => self.quick_search("а", 1).await,
        }
    }
}

const QUICK_SEARCH: &str = r#"query GetSearch($query: String, $limit: Int) {
  quickSearch(query: $query, limit: $limit) {
    content {
      __typename
      ... on Track {
        id
        title
        duration
        explicit
        artists { id title image { src } }
        release { id title date type image { src } }
      }
      ... on Artist {
        id
        title
        image { src }
      }
      ... on Release {
        id
        title
        date
        type
        image { src }
        artists { id title image { src } }
      }
      ... on Playlist {
        id
        title
        isPublic
        description
        duration
        image { src }
      }
    }
  }
}"#;

const SEARCH_ALL: &str = r#"query GetSearchAll(
  $query: String
  $limit: Int = 10
  $trackCursor: Cursor = null
  $artistsCursor: Cursor = null
  $releasesCursor: Cursor = null
  $playlistsCursor: Cursor = null
  $tracks: Boolean = true
  $artists: Boolean = true
  $releases: Boolean = true
  $playlists: Boolean = true
) {
  search(query: $query) {
    searchId
    tracks(limit: $limit, cursor: $trackCursor) @include(if: $tracks) {
      page { total prev next cursor }
      score
      items {
        id
        title
        availability
        explicit
        artistTemplate
        duration
        artists { id title }
        release { id title image { src } }
      }
    }
    artists(limit: $limit, cursor: $artistsCursor) @include(if: $artists) {
      page { total prev next cursor }
      score
      items {
        id
        title
        searchTitle
        description
        image { src }
      }
    }
    releases(limit: $limit, cursor: $releasesCursor) @include(if: $releases) {
      page { total prev next cursor }
      score
      items {
        id
        title
        searchTitle
        explicit
        availability
        date
        artists { id title }
        image { src }
      }
    }
    playlists(limit: $limit, cursor: $playlistsCursor) @include(if: $playlists) {
      page { total prev next cursor }
      score
      items {
        id
        title
        isPublic
        description
        duration
        image { src }
      }
    }
  }
}"#;

const GET_STREAM: &str = r#"query GetStream($ids: [ID!]!) {
  mediaContents(ids: $ids) {
    __typename
    ... on Track {
      stream {
        expire
        expireDelta
        flacdrm
        high
        mid
      }
    }
    ... on Episode {
      stream {
        expire
        expireDelta
        high
        mid
      }
    }
    ... on Chapter {
      stream {
        expire
        expireDelta
        high
        mid
      }
    }
  }
}"#;

const GET_TRACKS: &str = r#"query GetTracks($ids: [ID!]!) {
  getTracks(ids: $ids) {
    id
    title
    searchTitle
    position
    duration
    availability
    artistTemplate
    condition
    explicit
    lyrics
    zchan
    hasFlac
    artists { id title image { src } }
    release { id title image { src } }
  }
}"#;

const GET_PLAYLISTS: &str = r#"query GetPlaylists($ids: [ID!]!) {
  playlists(ids: $ids) {
    id
    title
    searchTitle
    updated
    description
    image { src palette paletteBottom }
    isPublic
    duration
    tracks {
      id
      credits
      title
      searchTitle
      position
      duration
      availability
      artistTemplate
      condition
      explicit
      hasFlac
      zchan
      artists { id title }
      release { id title image { src } }
    }
  }
}"#;

const GET_RELEASES: &str = r#"query GetReleases($ids: [ID!]!, $withTracks: Boolean = false, $withArtists: Boolean = false) {
  getReleases(ids: $ids) {
    id
    title
    searchTitle
    type
    date
    image { src palette paletteBottom }
    artistTemplate
    artists @include(if: $withArtists) { id title image { src } }
    tracks @include(if: $withTracks) {
      id
      title
      searchTitle
      duration
      position
      availability
      artistTemplate
      condition
      explicit
      hasFlac
      zchan
      stream { expire expireDelta flac flacdrm high mid }
      artists { id title }
      release { id title image { src } }
    }
  }
}"#;

const USER_COLLECTION: &str = r#"query userCollection {
  collection {
    artists { id collectionLastModified }
    episodes { id collectionLastModified }
    podcasts { id collectionLastModified }
    playlists { id collectionLastModified }
    synthesisPlaylists { id collectionLastModified }
    profiles { id collectionLastModified }
    releases { id collectionLastModified }
    tracks { id collectionLastModified }
  }
}"#;

const USER_TRACKS: &str = r#"query userTracks($orderBy: TrackOrderByType, $orderDirection: OrderDirectionType) {
  collection {
    tracks(orderBy: $orderBy, orderDirection: $orderDirection) {
      id
      collectionItemData {
        lastModified
      }
    }
  }
}"#;

const USER_PLAYLISTS: &str = r#"query userPlaylists {
  collection {
    playlists {
      id
      userId
      collectionLastModified
    }
  }
}"#;

const ADD_ITEM: &str = r#"mutation addItemToCollection($id: ID, $type: CollectionItemType) {
  collection {
    addItem(id: $id, type: $type)
  }
}"#;

const REMOVE_ITEM: &str = r#"mutation removeItemFromCollection($id: ID, $type: CollectionItemType) {
  collection {
    removeItem(id: $id, type: $type)
  }
}"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn anonymous_token_works() {
        let token = ZvukApi::anonymous_token().await.unwrap();
        assert!(!token.is_empty());
        println!("anon token: {}...", &token[..token.len().min(8)]);
    }

    #[tokio::test]
    async fn search_works() {
        let token = ZvukApi::anonymous_token().await.unwrap();
        let api = ZvukApi::new(token);
        let res = api.quick_search("меладзе", 3).await.unwrap();
        println!("quick_search: {res}");
    }

    #[tokio::test]
    async fn full_search_works() {
        let token = ZvukApi::anonymous_token().await.unwrap();
        let api = ZvukApi::new(token);
        let res = api.search("меладзе", 5).await.unwrap();
        println!("search: {res}");
    }

    #[tokio::test]
    async fn stream_works() {
        let token = ZvukApi::anonymous_token().await.unwrap();
        let api = ZvukApi::new(token);
        let s = api.search("меладзе", 3).await.unwrap();
        let track_id = s["search"]["tracks"]["items"][0]["id"]
            .as_str()
            .expect("no track id");
        let res = api.stream(&[track_id.to_string()]).await.unwrap();
        println!("stream: {res}");
        assert!(res["mediaContents"][0].get("stream").is_some());
    }

    #[tokio::test]
    async fn collection_with_anon() {
        let token = ZvukApi::anonymous_token().await.unwrap();
        let api = ZvukApi::new(token);
        match api.user_collection().await {
            Ok(v) => println!("user_collection ok: {v}"),
            Err(e) => println!("user_collection err: {e}"),
        }
        match api.user_tracks().await {
            Ok(v) => println!("user_tracks ok: {v}"),
            Err(e) => println!("user_tracks err: {e}"),
        }
    }

    #[tokio::test]
    async fn verify_garbage_token() {
        let api = ZvukApi::new("garbage-token".into());
        match api.verify().await {
            Ok(v) => println!("verify ok (unexpected): {v}"),
            Err(e) => println!("verify err: {e}"),
        }
    }
}
