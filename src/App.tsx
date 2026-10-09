import { type FormEvent, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";

type AnalysisResult = {
  plant: string;
  scientificName: string;
  condition: string;
  confidence: number | null;
  alternatives?: Array<{ name: string; evidence: string }>;
  description: string;
  steps: string[];
  healthAssessmentAvailable: boolean;
};

type AnalyzeResponse = {
  result: AnalysisResult;
};

type User = { id: string; name: string; email: string };
type AdvisorMessage = { role: "user" | "assistant"; content: string; createdAt?: string };
type WeatherData = {
  city: string;
  temperature: number;
  humidity: number;
  rainProbability: number;
  code: number;
};

const maxUploadBytes = 10 * 1024 * 1024;
const maxAnalysisDimension = 2048;
const analysisTimeoutMs = 210_000;
const weatherCodes: Record<number, string> = {
  0: "Açık",
  1: "Az bulutlu",
  2: "Parçalı bulutlu",
  3: "Kapalı",
  45: "Sisli",
  48: "Sisli",
  51: "Hafif çiseleme",
  53: "Çiseleme",
  55: "Kuvvetli çiseleme",
  61: "Hafif yağmur",
  63: "Yağmurlu",
  65: "Kuvvetli yağmur",
  71: "Hafif kar",
  73: "Karlı",
  75: "Kuvvetli kar",
  80: "Sağanak",
  81: "Sağanak",
  82: "Kuvvetli sağanak",
  95: "Gök gürültülü",
};

function AuthScreen({
  apiBaseUrl,
  isNative,
  onAuthenticated,
}: {
  apiBaseUrl: string;
  isNative: boolean;
  onAuthenticated: (user: User, sessionToken?: string) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const response = await fetch(`${apiBaseUrl}/api/auth/${mode}`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(isNative ? { "X-App-Platform": "capacitor" } : {}),
        },
        body: JSON.stringify({ name, email, password }),
      });
      const payload = await response.json() as { user?: User; sessionToken?: string; error?: string };
      if (!response.ok || !payload.user) {
        throw new Error(payload.error || "Hesabınıza erişilemedi. Lütfen tekrar deneyin.");
      }
      if (isNative && !payload.sessionToken) {
        throw new Error("Güvenli mobil oturum başlatılamadı. Lütfen tekrar deneyin.");
      }
      onAuthenticated(payload.user, payload.sessionToken);
    } catch (requestError) {
      setError(requestError instanceof TypeError
        ? "Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin."
        : requestError instanceof Error && requestError.message
          ? requestError.message
          : "Hesabınıza erişilemedi. Lütfen tekrar deneyin.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-decoration" aria-hidden="true"><LeafMark /></div>
      <section className="auth-card">
        <span className="step-label">TARIM ASİSTANI</span>
        <h1>{mode === "login" ? <>Üretiminize<br /><span>iyi bakın.</span></> : <>Aramıza<br /><span>hoş geldiniz.</span></>}</h1>
        <p className="auth-description">
          Hava durumunu takip edin, bitkilerinizi tanıyın ve tarlanıza özel fikirler alın.
        </p>
        <div className="auth-tabs" role="tablist" aria-label="Hesap işlemi">
          <button type="button" role="tab" aria-selected={mode === "login"} onClick={() => { setMode("login"); setError(""); }}>Giriş yap</button>
          <button type="button" role="tab" aria-selected={mode === "register"} onClick={() => { setMode("register"); setError(""); }}>Hesap oluştur</button>
        </div>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          {mode === "register" && (
            <label>Ad soyad
              <input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={60} required />
            </label>
          )}
          <label>E-posta adresi
            <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} required />
          </label>
          <label>Şifre
            <input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} maxLength={128} required />
          </label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="button button-primary auth-submit" disabled={busy} type="submit">
            {busy ? <><span className="spinner" /> İşleniyor…</> : mode === "login" ? "Güvenli giriş yap" : "Ücretsiz hesap oluştur"}
          </button>
        </form>
        <p className="auth-privacy">Hesap oluşturduğunuzda e-posta adresiniz ve giriş/çıkış IP kayıtlarınız hesabınızın güvenliği için saklanır.</p>
      </section>
      <div className="auth-side-copy">
        <span>TOPRAĞINIZ İÇİN</span>
        <h2>Doğru bilgi,<br />bereketli yarınlar.</h2>
        <p>Hava, bitki sağlığı ve yapay zekâ destekli tarım fikirleri tek yerde.</p>
      </div>
    </main>
  );
}

function isAnalysisResult(value: unknown): value is AnalysisResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return typeof result.plant === "string" &&
    typeof result.scientificName === "string" &&
    typeof result.condition === "string" &&
    (typeof result.confidence === "number" || result.confidence === null) &&
    typeof result.description === "string" &&
    Array.isArray(result.steps) &&
    result.steps.every((step) => typeof step === "string") &&
    typeof result.healthAssessmentAvailable === "boolean" &&
    (result.alternatives === undefined || (
      Array.isArray(result.alternatives) &&
      result.alternatives.every((item) =>
        item && typeof item.name === "string" && typeof item.evidence === "string",
      )
    ));
}

function LeafMark({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 32 32"
      fill="none"
    >
      <path
        d="M26.7 5.3C14.1 4.7 6 9 6 18.1c0 5 3.2 8.1 7.5 8.1 8.8 0 13.8-9.6 13.2-20.9Z"
        fill="currentColor"
      />
      <path
        d="M5 27c4.8-7.2 9.4-11.3 16.7-15.2"
        stroke="white"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" fill="none">
      <path
        d="M16 21V5m0 0L9.5 11.5M16 5l6.5 6.5M6 20v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isNative = Capacitor.isNativePlatform();
  const [apiBaseUrl, setApiBaseUrl] = useState(
    () => window.localStorage.getItem("tarim-asistani-api-url") || import.meta.env.VITE_API_BASE_URL || "",
  );
  const [apiUrlDraft, setApiUrlDraft] = useState(apiBaseUrl);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState("");
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [aiActive, setAiActive] = useState(false);
  const [weatherCity, setWeatherCity] = useState("Ankara");
  const [weatherError, setWeatherError] = useState("");
  const [advisorMessages, setAdvisorMessages] = useState<AdvisorMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [advisorDraft, setAdvisorDraft] = useState("");
  const [advisorBusy, setAdvisorBusy] = useState(false);
  const [advisorError, setAdvisorError] = useState("");
  const [logoutBusy, setLogoutBusy] = useState(false);
  const hasScientificName = result?.scientificName &&
    !/^(belirlenemedi|bilinmiyor|unknown|not identified)$/i.test(result.scientificName.trim());

  function sessionHeaders(json = false): Record<string, string> {
    const token = isNative ? window.localStorage.getItem("tarim-asistani-session-token") : null;
    return {
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(isNative ? { "X-App-Platform": "capacitor" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiBaseUrl}/api/auth/me`, { credentials: "include", headers: sessionHeaders(), signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { user?: User; error?: string };
        if (response.ok && payload.user) setUser(payload.user);
        else if (response.status === 401 && isNative) window.localStorage.removeItem("tarim-asistani-session-token");
        else if (response.status !== 401) setAuthError(payload.error || "Hesap hizmetine ulaşılamadı.");
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name === "AbortError") return;
        setAuthError("Hesap sunucusuna ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.");
      })
      .finally(() => setAuthChecked(true));
    return () => controller.abort();
  }, [apiBaseUrl, isNative]);

  useEffect(() => {
    if (!user) return;
    void loadWeather(39.9255, 32.8663, "Ankara");
    fetch(`${apiBaseUrl}/health`)
      .then((response) => response.json() as Promise<{ aiAssistantConfigured?: boolean }>)
      .then((payload) => setAiActive(Boolean(payload.aiAssistantConfigured)))
      .catch(() => setAiActive(false));
    fetch(`${apiBaseUrl}/api/conversations`, { credentials: "include", headers: sessionHeaders() })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as { conversations?: Array<{ id: string; messages: AdvisorMessage[] }> };
        const latest = payload.conversations?.[0];
        if (latest) {
          setConversationId(latest.id);
          setAdvisorMessages(latest.messages);
        }
      })
      .catch(() => setAdvisorError("Kayıtlı konuşmalar yüklenemedi."));
  }, [apiBaseUrl, user, isNative]);

  async function loadWeather(latitude: number, longitude: number, city: string) {
    setWeatherError("");
    try {
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.search = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: "temperature_2m,relative_humidity_2m,weather_code",
        daily: "precipitation_probability_max",
        forecast_days: "2",
        timezone: "auto",
      }).toString();
      const response = await fetch(url);
      if (!response.ok) throw new Error("Hava durumu alınamadı.");
      const payload = await response.json() as {
        current?: { temperature_2m?: number; relative_humidity_2m?: number; weather_code?: number };
        daily?: { precipitation_probability_max?: number[] };
      };
      if (
        typeof payload.current?.temperature_2m !== "number" ||
        typeof payload.current.relative_humidity_2m !== "number" ||
        typeof payload.current.weather_code !== "number"
      ) throw new Error("Hava durumu yanıtı eksik.");
      setWeather({
        city,
        temperature: Math.round(payload.current.temperature_2m),
        humidity: payload.current.relative_humidity_2m,
        rainProbability: payload.daily?.precipitation_probability_max?.[0] ?? 0,
        code: payload.current.weather_code,
      });
      setWeatherCity(city);
    } catch (weatherRequestError) {
      setWeatherError(weatherRequestError instanceof Error ? weatherRequestError.message : "Hava durumu alınamadı.");
    }
  }

  async function searchWeather(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = weatherCity.trim();
    if (!query) return;
    setWeatherError("");
    try {
      const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
      url.search = new URLSearchParams({ name: query, count: "1", language: "tr", format: "json" }).toString();
      const response = await fetch(url);
      if (!response.ok) throw new Error("Konum aranamadı.");
      const payload = await response.json() as { results?: Array<{ name: string; latitude: number; longitude: number; admin1?: string }> };
      const location = payload.results?.[0];
      if (!location) throw new Error("Bu isimle bir konum bulunamadı.");
      await loadWeather(location.latitude, location.longitude, location.admin1 ? `${location.name}, ${location.admin1}` : location.name);
    } catch (weatherRequestError) {
      setWeatherError(weatherRequestError instanceof Error ? weatherRequestError.message : "Konum aranamadı.");
    }
  }

  async function useDeviceLocation() {
    if (!navigator.geolocation) {
      setWeatherError("Bu cihaz konum bilgisini desteklemiyor.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => void loadWeather(position.coords.latitude, position.coords.longitude, "Konumunuz"),
      () => setWeatherError("Konum alınamadı. Şehir adını arayarak devam edebilirsiniz."),
      { timeout: 10000 },
    );
  }

  async function askAdvisor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = advisorDraft.trim();
    if (!message || advisorBusy) return;
    const userMessage: AdvisorMessage = { role: "user", content: message, createdAt: new Date().toISOString() };
    setAdvisorMessages((messages) => [...messages, userMessage]);
    setAdvisorDraft("");
    setAdvisorError("");
    setAdvisorBusy(true);
    try {
      const response = await fetch(`${apiBaseUrl}/api/assistant`, {
        method: "POST",
        credentials: "include",
        headers: sessionHeaders(true),
        body: JSON.stringify({ message, conversationId }),
      });
      const payload = await response.json() as { conversationId?: string; message?: AdvisorMessage; error?: string };
      if (payload.conversationId) setConversationId(payload.conversationId);
      if (!response.ok || !payload.message) throw new Error(payload.error || "Danışma yanıtı alınamadı.");
      setAdvisorMessages((messages) => [...messages, payload.message!]);
    } catch (requestError) {
      setAdvisorError(requestError instanceof Error
        ? requestError.message
        : "AI danışma servisine ulaşılamadı.");
    } finally {
      setAdvisorBusy(false);
    }
  }

  async function signOut() {
    setLogoutBusy(true);
    try {
      const response = await fetch(`${apiBaseUrl}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
        headers: sessionHeaders(),
      });
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        throw new Error(payload.error || "Oturum kapatılamadı.");
      }
      if (isNative) window.localStorage.removeItem("tarim-asistani-session-token");
      setUser(null);
      setAdvisorMessages([]);
      setConversationId(null);
      setAdvisorDraft("");
      setAuthError("");
    } catch (requestError) {
      setAuthError(requestError instanceof Error ? requestError.message : "Oturum kapatılamadı. Lütfen tekrar deneyin.");
    } finally {
      setLogoutBusy(false);
    }
  }

  function acceptAuthenticatedUser(authenticatedUser: User, sessionToken?: string) {
    if (isNative && sessionToken) {
      try {
        window.localStorage.setItem("tarim-asistani-session-token", sessionToken);
      } catch {
        setAuthError("Mobil oturum bu cihazda güvenle saklanamadı. Depolama alanını kontrol edip tekrar deneyin.");
        return;
      }
    }
    setAuthError("");
    setUser(authenticatedUser);
  }

  function saveApiUrl() {
    let parsed: URL;
    try {
      parsed = new URL(apiUrlDraft.trim());
    } catch {
      setError("Geçerli bir HTTPS API adresi girin. Örnek: https://api.ornek.com");
      return;
    }
    if (parsed.protocol !== "https:") {
      setError("Güvenli bağlantı için API adresi https:// ile başlamalıdır.");
      return;
    }
    const normalizedUrl = parsed.toString().replace(/\/+$/, "");
    try {
      localStorage.setItem("tarim-asistani-api-url", normalizedUrl);
    } catch {
      setError("API adresi bu cihazda kaydedilemedi. Cihaz depolama alanını kontrol edip tekrar deneyin.");
      return;
    }
    setApiBaseUrl(normalizedUrl);
    setApiUrlDraft(normalizedUrl);
    setError("");
  }

  useEffect(
    () => () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    },
    [imageUrl],
  );

  function selectFile(file?: File) {
    setError("");
    setResult(null);
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Lütfen JPG, PNG veya WEBP biçiminde bir görsel seçin.");
      return;
    }
    if (file.size > maxUploadBytes) {
      setError("Görsel boyutu 10 MB'dan küçük olmalıdır.");
      return;
    }
    setSelectedFile(file);
    setImageUrl(URL.createObjectURL(file));
    setFileName(file.name);
  }

  async function takePhoto(source: CameraSource) {
    setError("");
    try {
      const photo = await Camera.getPhoto({
        quality: 85,
        resultType: CameraResultType.Base64,
        source,
      });
      if (!photo.base64String) {
        throw new Error("Fotoğraf alınamadı. Lütfen yeniden deneyin.");
      }
      const mimeType = `image/${photo.format === "jpg" ? "jpeg" : photo.format}`;
      const file = new File(
        [Uint8Array.from(atob(photo.base64String), (character) => character.charCodeAt(0))],
        `yaprak-fotografi.${photo.format}`,
        { type: mimeType },
      );
      selectFile(file);
    } catch (photoError) {
      if (photoError instanceof Error && /cancel|canceled|cancelled/i.test(photoError.message)) return;
      setError(photoError instanceof Error ? photoError.message : "Fotoğraf alınırken bir hata oluştu.");
    }
  }

  function clearImage() {
    setImageUrl(null);
    setSelectedFile(null);
    setFileName("");
    setResult(null);
    setError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function analyzeImage() {
    const file = selectedFile;
    if (!file || isAnalyzing) return;
    setError("");
    setResult(null);
    setIsAnalyzing(true);
    try {
      if (isNative && !apiBaseUrl) {
        throw new Error("Önce API sunucusu ayarına herkese açık HTTPS adresinizi girip kaydedin.");
      }
      const imageDataUrl = await prepareImageAsDataUrl(file);
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), analysisTimeoutMs);
      let response: Response;
      let payload: unknown;
      try {
        response = await fetch(`${apiBaseUrl}/api/analyze`, {
          method: "POST",
          credentials: "include",
          headers: sessionHeaders(true),
          body: JSON.stringify({ imageDataUrl }),
          signal: controller.signal,
        });
        try {
          payload = await response.json();
        } catch (responseError) {
          if (responseError instanceof Error && responseError.name === "AbortError") {
            throw responseError;
          }
          throw new Error("Sunucudan okunabilir yanıt alınamadı. Lütfen tekrar deneyin.");
        }
      } finally {
        window.clearTimeout(timeout);
      }
      const responsePayload = payload && typeof payload === "object"
        ? payload as Partial<AnalyzeResponse> & { error?: unknown }
        : {};
      if (!response.ok) {
        throw new Error(
          typeof responsePayload.error === "string"
            ? responsePayload.error
            : `Analiz başarısız oldu (HTTP ${response.status}). Lütfen tekrar deneyin.`,
        );
      }
      if (!isAnalysisResult(responsePayload.result)) {
        throw new Error("Analiz yanıtı beklenen biçimde değildi. Lütfen tekrar deneyin.");
      }
      setResult(responsePayload.result);
      window.setTimeout(
        () => document.getElementById("analysis-result")?.scrollIntoView({ behavior: "smooth", block: "start" }),
        50,
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error && requestError.name === "AbortError"
          ? "Analiz çok uzun sürdü ve zaman sınırına ulaştı. Bağlantınızı kontrol edip tekrar deneyin."
          : requestError instanceof TypeError && /fetch|network/i.test(requestError.message)
            ? "Sunucuya ulaşılamadı. İnternet bağlantınızı ve API sunucu adresini kontrol edip tekrar deneyin."
          : requestError instanceof Error
            ? requestError.message
            : "Analiz sırasında beklenmeyen bir hata oluştu.",
      );
    } finally {
      setIsAnalyzing(false);
    }
  }

  if (!authChecked) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <a className="brand" href="#" aria-label="Tarım Asistanı ana sayfa"><span className="brand-mark"><LeafMark /></span><span>tarım<span className="brand-light">asistanı</span></span></a>
        </header>
        <div className="session-loading"><span className="spinner spinner-green" /> Güvenli oturum kontrol ediliyor…</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <a className="brand" href="#" aria-label="Tarım Asistanı ana sayfa"><span className="brand-mark"><LeafMark /></span><span>tarım<span className="brand-light">asistanı</span></span></a>
          <span className="header-note"><span className="online-dot" /> Üreticinin dijital yardımcısı</span>
        </header>
        {isNative && (
          <section className={`api-settings ${apiBaseUrl ? "" : "api-settings-missing"}`} aria-label="API sunucusu ayarı">
            <div className="api-settings-copy">
              <strong>{apiBaseUrl ? "API sunucusu ayarlandı" : "API sunucusu adresi gerekli"}</strong>
              <p>Giriş ve bitki tanıma hizmetleri güvenli sunucu bağlantısıyla çalışır.</p>
            </div>
            <div className="api-settings-controls">
              <label className="visually-hidden" htmlFor="api-base-url">HTTPS API sunucusu adresi</label>
              <input id="api-base-url" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" placeholder="https://api.ornek.com" value={apiUrlDraft} onChange={(event) => setApiUrlDraft(event.target.value)} />
              <button className="button button-secondary" type="button" onClick={saveApiUrl}>Adresi kaydet</button>
            </div>
          </section>
        )}
        {authError && <div className="auth-service-error" role="status">{authError}</div>}
        <AuthScreen apiBaseUrl={apiBaseUrl} isNative={isNative} onAuthenticated={acceptAuthenticatedUser} />
        <footer className="footer"><span>Doğayla birlikte, daha bilinçli üretim.</span><span className="footer-disclaimer">Kişisel verileriniz güvenli oturumla korunur.</span></footer>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Tarım Asistanı ana sayfa">
          <span className="brand-mark">
            <LeafMark />
          </span>
          <span>tarım<span className="brand-light">asistanı</span></span>
        </a>
        <div className="header-actions">
          <span className="header-note"><span className="online-dot" /> {user.name}</span>
          <button className="signout-button" type="button" onClick={() => void signOut()} disabled={logoutBusy}>{logoutBusy ? "Çıkılıyor…" : "Çıkış yap"}</button>
        </div>
      </header>

      {isNative && (
        <section className={`api-settings ${apiBaseUrl ? "" : "api-settings-missing"}`} aria-label="API sunucusu ayarı">
          <div className="api-settings-copy">
            <strong>{apiBaseUrl ? "API sunucusu ayarlandı" : "API sunucusu adresi gerekli"}</strong>
            <p>Bitki tanıma anahtarı ve varsa hastalık değerlendirme anahtarı sunucuda güvenle saklanır.</p>
          </div>
          <div className="api-settings-controls">
            <label className="visually-hidden" htmlFor="api-base-url">HTTPS API sunucusu adresi</label>
            <input
              id="api-base-url"
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="https://api.ornek.com"
              value={apiUrlDraft}
              onChange={(event) => setApiUrlDraft(event.target.value)}
            />
            <button className="button button-secondary" type="button" onClick={saveApiUrl}>Adresi kaydet</button>
          </div>
        </section>
      )}

      <main>
        {authError && <div className="auth-service-error" role="alert">{authError}</div>}
        <section className="dashboard" aria-labelledby="dashboard-title">
          <div className="dashboard-heading">
            <div>
              <span className="step-label">BUGÜNKÜ DURUM</span>
              <h1 id="dashboard-title">Merhaba, <span>{user.name.split(" ")[0]}.</span></h1>
              <p>Üretiminiz için bugünün öne çıkan bilgileri.</p>
            </div>
            <span className={`ai-active ${aiActive ? "" : "ai-unavailable"}`}><span /> {aiActive ? "AI AKTİF" : "AI BAĞLANTISI YOK"}</span>
          </div>
          <div className="dashboard-grid">
            <section className="dashboard-card weather-card" aria-label="Hava durumu">
              <div className="dashboard-card-heading">
                <div><span className="dashboard-icon">☀</span><div><span className="card-kicker">YEREL HAVA</span><h2>{weather?.city || weatherCity}</h2></div></div>
                <button className="location-button" type="button" onClick={() => void useDeviceLocation()}>⌖ Konumum</button>
              </div>
              <form className="city-search" onSubmit={(event) => void searchWeather(event)}>
                <label className="visually-hidden" htmlFor="weather-city">Şehir ara</label>
                <input id="weather-city" value={weatherCity} onChange={(event) => setWeatherCity(event.target.value)} placeholder="Şehir adı" />
                <button type="submit" aria-label="Şehir için hava durumunu getir">Ara</button>
              </form>
              {weather ? (
                <div className="weather-summary">
                  <div><strong>{weather.temperature}°</strong><span>{weatherCodes[weather.code] || "Hava durumu"}</span></div>
                  <div className="weather-metrics"><span>Nem <b>%{weather.humidity}</b></span><span>48 sa. yağış <b>%{weather.rainProbability}</b></span></div>
                </div>
              ) : <p className="dashboard-muted">Hava durumu yükleniyor…</p>}
              {weatherError && <p className="dashboard-error" role="status">{weatherError}</p>}
              <p className="weather-source">Open-Meteo · Güncel tahmin</p>
            </section>

            <section className="dashboard-card notification-card" aria-label="Aktif yapay zekâ bildirimleri">
              <div className="notification-heading"><span className="notification-spark">✳</span><span className="card-kicker">AKILLI TARIM BİLDİRİMİ</span><span className="notification-live">AKTİF</span></div>
              <h2>{weather && weather.rainProbability >= 60 ? "Yağış olasılığı yüksek." : weather && weather.temperature >= 32 ? "Sıcaklık bitkileri zorlayabilir." : "Tarlanızı gözlemlemeyi unutmayın."}</h2>
              <p>{weather && weather.rainProbability >= 60
                ? `48 saatlik yağış olasılığı %${weather.rainProbability}. Sulama planınızı yağış tahminine göre gözden geçirin.`
                : weather && weather.temperature >= 32
                  ? "Sıcak saatlerde bitkilerinizi kontrol edin; sulama kararını toprak nemine göre verin."
                  : "Sulama öncesi toprağın nemini kontrol edin. Hava tahmini değiştikçe öneriler güncellenir."}</p>
              <span className="notification-foot">Hava tahminine dayalı güvenli öneri</span>
            </section>

            <a className="dashboard-action plant-action" href="#workspace">
              <span className="action-symbol"><LeafMark /></span>
              <span><small>BİTKİ TANIMA</small><strong>Yaprağını incele</strong><em>Fotoğrafla bitki sağlığına göz at →</em></span>
            </a>
            <a className="dashboard-action advisor-action" href="#advisor">
              <span className="action-symbol">✳</span>
              <span><small>FİKİR DANIŞMA</small><strong>Tarım asistanına sor</strong><em>Planını birlikte geliştirelim →</em></span>
            </a>

            <section className="dashboard-card advisor-card" id="advisor" aria-label="Fikir danışma">
              <div className="advisor-heading">
                <div><span className="dashboard-icon advisor-icon">✳</span><div><span className="card-kicker">FİKİR DANIŞMA</span><h2>Tarlanızı konuşalım</h2></div></div>
                <span className="advisor-safe">{aiActive ? "AI danışman hazır" : "AI servisi yapılandırılmamış"}</span>
              </div>
              <div className="advisor-messages" aria-live="polite">
                {advisorMessages.length === 0
                  ? <p className="advisor-empty">Ne ekmeyi planlıyorsunuz? Ürün seçimi, ekim takvimi veya bakım fikirlerinizi sorun.</p>
                  : advisorMessages.slice(-4).map((message, index) => (
                    <p className={`advisor-message ${message.role}`} key={`${message.role}-${index}`}>{message.content}</p>
                  ))}
                {advisorBusy && <p className="advisor-thinking"><span className="spinner spinner-green" /> Öneri hazırlanıyor…</p>}
              </div>
              <form className="advisor-form" onSubmit={(event) => void askAdvisor(event)}>
                <label className="visually-hidden" htmlFor="advisor-message">Danışma mesajınız</label>
                <input id="advisor-message" value={advisorDraft} onChange={(event) => setAdvisorDraft(event.target.value)} placeholder="Örneğin: Bu sezon ne ekebilirim?" maxLength={4000} />
                <button type="submit" disabled={advisorBusy || !advisorDraft.trim()} aria-label="Mesajı gönder">↑</button>
              </form>
              {advisorError && <p className="advisor-error" role="alert">{advisorError}</p>}
              <p className="advisor-privacy">Mesajlar konuşma geçmişinize kaydedilir ve yanıt oluşturmak için AI hizmetine iletilir.</p>
            </section>
          </div>
        </section>

        <section className="workspace" id="workspace" aria-label="Bitki fotoğrafı analizi">
          <div className="section-heading">
            <div>
              <span className="step-label">01 — FOTOĞRAFINI EKLE</span>
              <h2>Yaprağınız nasıl görünüyor?</h2>
            </div>
            <span className="privacy-note"><span aria-hidden="true">ⓘ</span> Bitki tanıma Pl@ntNet ile yapılır; belirti değerlendirmesinde NVIDIA kullanılabilir</span>
          </div>

          <div className={`upload-card ${isDragging ? "is-dragging" : ""} ${imageUrl ? "has-image" : ""}`}
            onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              selectFile(event.dataTransfer.files[0]);
            }}>
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture={isNative ? undefined : "environment"}
              aria-label="Yaprak fotoğrafı seç"
              onChange={(event) => selectFile(event.target.files?.[0])}
            />
            {imageUrl ? (
              <div className="preview-layout">
                <div className="preview-image-wrap">
                  <img src={imageUrl} alt="Seçilen yaprak fotoğrafı önizlemesi" className="preview-image" />
                  <span className="preview-badge"><span className="preview-dot" /> FOTOĞRAF HAZIR</span>
                </div>
                <div className="preview-details">
                  <span className="step-label">FOTOĞRAFINIZ</span>
                  <h3>Güzel görünüyor!</h3>
                  <p className="file-name" title={fileName}>{fileName}</p>
                  <p className="preview-tip">En iyi sonuç için yaprak detaylarının net ve aydınlık olduğundan emin olun.</p>
                  <button className="text-button" type="button" onClick={clearImage}>Fotoğrafı kaldır <span aria-hidden="true">×</span></button>
                </div>
              </div>
            ) : (
              <div className="upload-empty">
                <div className="upload-icon"><UploadIcon /></div>
                <h3>Yaprak fotoğrafınızı buraya bırakın</h3>
                <p>veya cihazınızdan bir fotoğraf seçin</p>
                {isNative ? (
                  <div className="photo-actions">
                    <button className="button button-secondary" type="button" onClick={() => void takePhoto(CameraSource.Camera)}>
                      <span aria-hidden="true">◉</span> Fotoğraf çek
                    </button>
                    <button className="button button-secondary" type="button" onClick={() => void takePhoto(CameraSource.Photos)}>
                      <span aria-hidden="true">▧</span> Galeriden seç
                    </button>
                  </div>
                ) : (
                  <button className="button button-secondary" type="button" onClick={() => fileInputRef.current?.click()}>
                    <span aria-hidden="true">＋</span> Fotoğraf seç
                  </button>
                )}
                <span className="file-hint">JPG, PNG veya WEBP · En fazla 10 MB</span>
              </div>
            )}
          </div>

          {error && <div className="error-message" role="alert"><span aria-hidden="true">!</span>{error}</div>}

          <div className="action-row">
            <p className="action-hint">
              {imageUrl ? "Fotoğrafınız hazır. Bitki türünü Pl@ntNet ile tanıyın." : "Başlamak için yaprak fotoğrafınızı yükleyin."}
            </p>
            <button className="button button-primary" type="button" onClick={analyzeImage} disabled={!imageUrl || isAnalyzing}>
              {isAnalyzing ? <><span className="spinner" /> Analiz ediliyor…</> : <>Yapay zekâyla incele <span aria-hidden="true">→</span></>}
            </button>
          </div>

          {isAnalyzing && (
            <div className="loading-card" role="status">
              <span className="spinner spinner-green" />
              <div><strong>Yaprak fotoğrafı analiz ediliyor</strong><p>Pl@ntNet bitki türünü tanıyor; hastalık değerlendirmesi etkinse NVIDIA belirtileri inceliyor…</p></div>
            </div>
          )}

          {result && (
            <section className="result-section" id="analysis-result" aria-labelledby="result-heading">
              <div className="result-heading">
                <div>
                  <span className="step-label">02 — PL@NTNET BİTKİ TANIMA</span>
                  <h2 id="result-heading">Bitkiniz hakkında</h2>
                </div>
                <span className="demo-pill"><span aria-hidden="true">ⓘ</span> Yapay zekâ tahmini · Kesin teşhis değildir</span>
              </div>
              <div className="result-card">
                <div className="demo-notice"><strong>Bilgilendirme:</strong> Bitki adı Pl@ntNet’in görsel eşleşmesidir; tür ve çeşit için kesin doğrulama değildir. Hastalık değerlendirmesi etkinse NVIDIA tarafından ayrıca üretilen bir ön değerlendirmedir; kesin teşhis yerine geçmez.</div>
                <div className="result-grid">
                  <div className="plant-block">
                    <span className="result-icon" aria-hidden="true"><LeafMark /></span>
                    <div>
                      <span className="result-label">PL@NTNET BİTKİ EŞLEŞMESİ</span>
                      <h3>{result.plant}</h3>
                      <span className="scientific-name">{hasScientificName ? result.scientificName : "Bilimsel türü henüz belirlenemedi"}</span>
                    </div>
                  </div>
                  <div className="condition-block">
                    <span className="result-label">{result.healthAssessmentAvailable ? "NVIDIA ÖN DEĞERLENDİRMESİ · OLASI BELİRTİ" : "HASTALIK DEĞERLENDİRMESİ"}</span>
                    <h3>{result.condition}</h3>
                    <p>{result.description}</p>
                    {result.alternatives && result.alternatives.length > 0 && (
                      <div className="alternative-list">
                        <strong>Pl@ntNet’in diğer görsel eşleşmeleri</strong>
                        <ul>{result.alternatives.map((alternative) => (
                          <li key={alternative.name}><b>{alternative.name}</b> — {alternative.evidence}</li>
                        ))}</ul>
                      </div>
                    )}
                  </div>
                  <div className="confidence-block">
                    <span className="result-label">PL@NTNET EŞLEŞME SKORU</span>
                    <div className="confidence-number">{result.confidence === null ? "—" : <>{result.confidence}<span>%</span></>}</div>
                    <span className="confidence-caption">{result.confidence === null ? "Eşleşme skoru alınamadı" : "Benzerlik puanıdır; doğrulanmış olasılık değildir"}</span>
                  </div>
                </div>
                <div className="steps-block">
                  <div className="steps-title"><span className="steps-icon" aria-hidden="true">✳</span><div><h3>Genel ve güvenli adımlar</h3><p>Kesin teşhis veya ilaç önerisi yerine:</p></div></div>
                  <ul>{result.steps.map((step) => <li key={step}><span aria-hidden="true">✓</span>{step}</li>)}</ul>
                </div>
                <p className="result-disclaimer">Yapay zekâ sonuçları hatalı olabilir; bu değerlendirme profesyonel bitki hastalığı teşhisi yerine geçmez.</p>
              </div>
            </section>
          )}
        </section>

        <section className="how-section">
          <div className="how-intro"><span className="step-label">ÇOK KOLAY</span><h2>Üç adımda başlayın</h2></div>
          <div className="how-steps">
            <div className="how-step"><span className="how-number">01</span><div><h3>Fotoğraf çekin</h3><p>Belirti görünen yaprağı yakından çekin.</p></div></div>
            <div className="how-step"><span className="how-number">02</span><div><h3>Görselinizi ekleyin</h3><p>Galeriden seçin veya kamerayı kullanın.</p></div></div>
            <div className="how-step"><span className="how-number">03</span><div><h3>Bilgi edinin</h3><p>Bitkiniz ve olası belirtiler hakkında bilgi alın.</p></div></div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <a className="brand footer-brand" href="#">
          <span className="brand-mark"><LeafMark /></span>
          <span>tarım<span className="brand-light">asistanı</span></span>
        </a>
        <span>Doğayla birlikte, daha bilinçli üretim.</span>
        <span className="footer-disclaimer">Tanı ve tedavi yerine geçmez.</span>
      </footer>
    </div>
  );
}

async function prepareImageAsDataUrl(file: File): Promise<string> {
  if (typeof createImageBitmap === "function") {
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(file);
      const scale = Math.min(
        1,
        maxAnalysisDimension / Math.max(bitmap.width, bitmap.height),
      );
      if (scale === 1 && file.type === "image/jpeg") {
        return await readImageAsDataUrl(file);
      }

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return await readImageAsDataUrl(file);

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const optimized = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.86),
      );
      if (optimized && optimized.size < file.size) {
        return await readImageAsDataUrl(optimized);
      }
    } catch {
      // Keep analysis available in browsers that cannot decode or resize this image.
    } finally {
      bitmap?.close();
    }
  }
  return readImageAsDataUrl(file);
}

function readImageAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Fotoğraf okunamadı. Lütfen başka bir görsel seçin."));
    };
    reader.onerror = () => reject(new Error("Fotoğraf okunamadı. Lütfen tekrar deneyin."));
    reader.readAsDataURL(file);
  });
}

export default App;
