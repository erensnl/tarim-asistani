import { useEffect, useRef, useState } from "react";
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

const maxUploadBytes = 10 * 1024 * 1024;
const maxAnalysisDimension = 2048;
const analysisTimeoutMs = 210_000;

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
  const hasScientificName = result?.scientificName &&
    !/^(belirlenemedi|bilinmiyor|unknown|not identified)$/i.test(result.scientificName.trim());

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
          headers: { "Content-Type": "application/json" },
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Tarım Asistanı ana sayfa">
          <span className="brand-mark">
            <LeafMark />
          </span>
          <span>tarım<span className="brand-light">asistanı</span></span>
        </a>
        <span className="header-note"><span className="online-dot" /> Üreticinin dijital yardımcısı</span>
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
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-line" /> BİTKİ SAĞLIĞI CEBİNİZDE</div>
            <h1>Yaprağınızı tanıyın.<br /><span>Bitkinize iyi bakın.</span></h1>
            <p className="hero-description">
              Bir yaprak fotoğrafı yükleyin; bitkinizin sağlığı hakkında anlaşılır
              bilgiler ve atabileceğiniz güvenli adımlar görün.
            </p>
            <div className="hero-trust">
              <span><span className="trust-check">✓</span> Kullanımı kolay</span>
              <span><span className="trust-check">✓</span> Türkçe ve anlaşılır</span>
            </div>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="sun-glow" />
            <div className="art-stem" />
            <div className="art-leaf art-leaf-one" />
            <div className="art-leaf art-leaf-two" />
            <div className="art-leaf art-leaf-three" />
            <div className="art-leaf art-leaf-four" />
            <div className="art-sparkle sparkle-one">✳</div>
            <div className="art-sparkle sparkle-two">✳</div>
            <div className="art-caption">Her yaprak<br />bir hikâye anlatır.</div>
          </div>
        </section>

        <section className="workspace" aria-label="Bitki fotoğrafı analizi">
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
