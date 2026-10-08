# Tarım Asistanı

Türkçe bitki fotoğrafı yükleme ve NVIDIA görsel yapay zekâsıyla bitki sağlığı değerlendirmesi sunan React + TypeScript uygulaması.

## Kurulum

1. NVIDIA API anahtarınızı [NVIDIA Build](https://build.nvidia.com/) üzerinden oluşturun.
2. Proje kökünde `.env.example` dosyasını `.env` adıyla kopyalayın ve `NVIDIA_API_KEY` alanına anahtarınızı girin.
3. Bağımlılıkları kurup geliştirme sunucularını başlatın:

```bash
npm install
npm run dev
```

Vite arayüzü `http://localhost:5173`, API sunucusu `http://localhost:3001` adresinde açılır. Vite `/api` isteklerini sunucuya yönlendirir.

Üretim derlemesi için `npm run build`; üretim sunucusunu başlatmak için `npm start` komutunu çalıştırın. `PORT` ve isteğe bağlı `NVIDIA_MODEL` değerleri `.env` dosyasında değiştirilebilir.

## Mobil uygulama

Proje Capacitor ile Android ve iOS uygulama kabuğu sağlar. Android derlemek için Android Studio/Android SDK ve Java; iOS derlemek için macOS ve Xcode gerekir. iOS projesi Windows'ta oluşturulup eşitlenebilir, ancak derlenemez.

Android debug APK'sını `artifacts/tarim-asistani-debug.apk` konumundan indirip Android cihazda test edebilirsiniz. Bu APK test amaçlı debug imzasıyla oluşturulmuştur; Google Play dağıtımı için release imzası gerekir.

### API sunucusunu yayımlama

Mobil uygulamanın analiz yapabilmesi için uygulama sahibinin bir defa backend'i internette yayımlaması gerekir; uygulama kullanıcıları kendilerine ait sunucu açmaz. Hazır dağıtım ayarı [Render Blueprint](render.yaml) olarak eklenmiştir. Yayımlamak için:

1. [Render Blueprint oluşturma sayfasını](https://dashboard.render.com/blueprint/new?repo=https%3A%2F%2Fgithub.com%2Ferensnl%2Ftarim-asistani) açıp GitHub hesabınızla giriş yapın ve **Apply** ile `tarim-asistani-api` servisini oluşturun.
2. Render sizden `NVIDIA_API_KEY` değerini isteyecek. NVIDIA Build'den aldığınız anahtarı bu gizli alana girin; anahtarı kaynak koda veya mobil uygulamaya eklemeyin.
3. İlk dağıtım tamamlanıp health check başarılı olduktan sonra Render Dashboard'da servisi açın. Servisin herkese açık `https://...onrender.com` adresi mobil API adresinizdir.
4. Mevcut APK'da bu adresi uygulamadaki **API sunucusu adresi** alanına bir kez girip kaydedin. Yeni APK'ya adresi sabitlemek için:

```bash
# PowerShell
$env:VITE_API_BASE_URL="https://SİZİN-SERVİSİNİZ.onrender.com"
npm run mobile:sync
npm run mobile:android
```

Render'ın ücretsiz servisi bir süre istek almadığında uykuya geçebilir; yeniden açılması ilk analiz isteğini geciktirebilir. `VITE_` ile başlayan değişkenler mobil istemci paketine eklenir; NVIDIA anahtarını hiçbir zaman bu şekilde eklemeyin. Android Studio'dan cihaz/emülatör seçerek çalıştırabilirsiniz. `npm run mobile:ios` komutu iOS projesini Xcode'da açar (macOS gerekir). `npm run mobile:sync` web uygulamasını derleyip Capacitor platformlarına kopyalar. Mobil uygulama kamera ve galeriden yaprak fotoğrafı seçebilir.

## Analiz akışı

- JPG, PNG ve WEBP görseli seçme, sürükleyip bırakma, mobil kamerayla çekme ve önizleme.
- Tarayıcıda dosya türü ve 10 MB boyut kontrolü.
- API anahtarı yalnızca Express sunucusunda kalır; React uygulamasına gönderilmez.
- Sunucu görseli NVIDIA'nın OpenAI uyumlu `integrate.api.nvidia.com/v1/chat/completions` API'sine iletir.
- Varsayılan görsel modeli `meta/llama-3.2-90b-vision-instruct` olarak ayarlanmıştır. Sunucu, Türkiye'de yaygın yaklaşık 39 kültür bitkisinin Türkçe/İngilizce adlarını, Latince adlarını ve ayırt edici yaprak özelliklerini modele referans olarak verir; fındık, tütün ve yer fıstığı da listededir.
- Alternatif bitki adları yalnızca katalogda varsa ve yanlarında fotoğraftan gözlemlenebilir Türkçe kanıt sunulmuşsa gösterilir. Eski biçimdeki gerekçesiz metin alternatifleri gizlenir; İngilizce açıklamalar sonuç ekranında Türkçe güvenli açıklamayla değiştirilir.
- Bu referans liste modele yeniden eğitim yaptırmaz ve dünyadaki bütün bitkileri kapsamaz. Görsel modeli fotoğraftaki ayrıntılara göre tahminde bulunur; ayırt edici özellikler görünmüyorsa belirsizliğini belirtmelidir. Bütün bitkileri güvenilir biçimde tanımak için etiketli fotoğraflarla eğitilmiş/ince ayar yapılmış bir model veya özelleşmiş bitki tanıma servisi gerekir.
- Sunucu, model yanıtını doğrular ve biçimini arayüze uygun hale getirir. API anahtarı yoksa, geçersizse, istek sınırı aşılırsa veya servis yanıt vermezse kullanıcıya hata gösterilir.

## Gizlilik ve güvenli kullanım

Analiz istendiğinde yüklenen görsel NVIDIA API'sine gönderilir; bu işlem arayüzde kullanıcıya bildirilir. Anahtarı `.env` içinde saklayın ve `.env` dosyasını paylaşmayın. Uygulama, NVIDIA'dan gelen çıktıyı kesin tanı olarak değil yapay zekâ tahmini olarak sunar; güven düzeyi doğrulanmış olasılık değildir. Modelden ilaç veya pestisit reçetesi vermemesi istenir; bitki sağlığı kararlarında uzman görüşü alınmalıdır.
