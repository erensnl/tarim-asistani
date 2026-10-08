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
};

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
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const hasScientificName = result?.scientificName &&
    !/^(belirlenemedi|bilinmiyor|unknown|not identified)$/i.test(result.scientificName.trim());

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
    if (file.size > 10 * 1024 * 1024) {
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
      const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
      if (isNative && !apiBaseUrl) {
        throw new Error("Mobil uygulama için API adresi ayarlanmamış. VITE_API_BASE_URL değerini yapılandırın.");
      }
      const imageDataUrl = await readImageAsDataUrl(file);
      const response = await fetch(`${apiBaseUrl}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageDataUrl }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Analiz sırasında bir hata oluştu.");
      }
      setResult(payload.result as AnalysisResult);
      window.setTimeout(
        () => document.getElementById("analysis-result")?.scrollIntoView({ behavior: "smooth", block: "start" }),
        50,
      );
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Analiz sırasında beklenmeyen bir hata oluştu.");
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
            <span className="privacy-note"><span aria-hidden="true">ⓘ</span> Analiz için NVIDIA'ya gönderilir</span>
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
              {imageUrl ? "Fotoğrafınız hazır. NVIDIA yapay zekâsıyla analiz edin." : "Başlamak için yaprak fotoğrafınızı yükleyin."}
            </p>
            <button className="button button-primary" type="button" onClick={analyzeImage} disabled={!imageUrl || isAnalyzing}>
              {isAnalyzing ? <><span className="spinner" /> Analiz ediliyor…</> : <>Yapay zekâyla incele <span aria-hidden="true">→</span></>}
            </button>
          </div>

          {isAnalyzing && (
            <div className="loading-card" role="status">
              <span className="spinner spinner-green" />
              <div><strong>Yaprak fotoğrafı analiz ediliyor</strong><p>NVIDIA görsel modeli bitkiyi ve yaprak belirtilerini inceliyor…</p></div>
            </div>
          )}

          {result && (
            <section className="result-section" id="analysis-result" aria-labelledby="result-heading">
              <div className="result-heading">
                <div>
                  <span className="step-label">02 — YAPAY ZEKÂ ANALİZİ</span>
                  <h2 id="result-heading">Bitkiniz hakkında</h2>
                </div>
                <span className="demo-pill"><span aria-hidden="true">ⓘ</span> Yapay zekâ tahmini · Kesin teşhis değildir</span>
              </div>
              <div className="result-card">
                <div className="demo-notice"><strong>Bilgilendirme:</strong> Bu sonuç görselden üretilmiş yapay zekâ tahminidir; kesin teşhis veya doğrulanmış hastalık olasılığı değildir. Karar vermeden önce bir ziraat uzmanına danışın.</div>
                <div className="result-grid">
                  <div className="plant-block">
                    <span className="result-icon" aria-hidden="true"><LeafMark /></span>
                    <div><span className="result-label">TÜRKÇE ADI (İNGİLİZCE ADI)</span><h3>{result.plant}</h3><span className="scientific-name">{hasScientificName ? result.scientificName : "Bilimsel türü henüz belirlenemedi"}</span></div>
                  </div>
                  <div className="condition-block">
                    <span className="result-label">OLASI BELİRTİ</span>
                    <h3>{result.condition}</h3>
                    <p>{result.description}</p>
                    {result.alternatives && result.alternatives.length > 0 && (
                      <div className="alternative-list">
                        <strong>Görsel kanıtı olan diğer olasılıklar</strong>
                        <ul>{result.alternatives.map((alternative) => (
                          <li key={alternative.name}><b>{alternative.name}</b> — {alternative.evidence}</li>
                        ))}</ul>
                      </div>
                    )}
                  </div>
                  <div className="confidence-block">
                    <span className="result-label">GÖRSEL TAHMİN DÜZEYİ</span>
                    <div className="confidence-number">{result.confidence === null ? "—" : <>{result.confidence}<span>%</span></>}</div>
                    <span className="confidence-caption">{result.confidence === null ? "Model güven düzeyi bildirmedi" : "Modelin kaba tahmini; doğrulanmış olasılık değildir"}</span>
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

function readImageAsDataUrl(file: File): Promise<string> {
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
