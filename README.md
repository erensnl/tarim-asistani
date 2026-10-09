# Tarım Asistanı

Türkçe tarım asistanı; zorunlu hesap girişi, canlı hava durumu, bitki fotoğrafı tanıma ve tarım fikirleri için AI danışma sunar. Hesaplar, oturumlar ve konuşma geçmişi MongoDB'de saklanır.

## Kurulum

1. MongoDB Atlas'ta bir küme oluşturun; veritabanı kullanıcısı ve ağ erişim izinlerini ayarlayıp bağlantı URI'sini alın.
2. [Pl@ntNet API sayfasından](https://my.plantnet.org/) hesap açıp API anahtarı alın.
3. [NVIDIA Build](https://build.nvidia.com/) üzerinden `NVIDIA_API_KEY` alın; fikir danışma ve isteğe bağlı hastalık ön değerlendirmesi bu anahtarı kullanır.
4. Proje kökünde `.env.example` dosyasını `.env` adıyla kopyalayın; `MONGODB_URI`, `PLANTNET_API_KEY` ve `NVIDIA_API_KEY` değerlerini girin.
5. Bağımlılıkları kurup geliştirme sunucularını başlatın:

```bash
npm install
npm run dev
```

Vite arayüzü `http://localhost:5173`, API sunucusu `http://localhost:3001` adresinde açılır. Vite `/api` isteklerini sunucuya yönlendirir. MongoDB bağlantısı yoksa uygulama hesap oluşturma/girişi etkinleştirmez; sunucu bu durumu açıkça bildirir.

MongoDB Atlas bağlantısını ayarlarken Atlas'taki veritabanı kullanıcısını ve **Network Access** IP izinlerini kontrol edin. Parolada `@`, `:`, `/` gibi URI özel karakterleri varsa URI içindeki parola bölümünü URL-encode edin. `.env` dosyasını düzenledikten sonra `npm run db:check` komutuyla bağlantıyı test edin; komut bağlantı bilgisini yazdırmaz. Render dağıtımında aynı URI'yi servisin gizli `MONGODB_URI` ortam değişkenine ekleyin; URI'yi sohbetlere veya kaynak koda koymayın.

Üretim derlemesi için `npm run build`; üretim sunucusunu başlatmak için `npm start` komutunu çalıştırın. `PORT`, `MONGODB_DATABASE` ve `NVIDIA_MODEL` değerleri `.env` dosyasında değiştirilebilir.

## Hesaplar ve ana sayfa

- Tüm bitki analizi, danışma ve konuşma geçmişi uç noktaları giriş gerektirir. Parolalar sunucuda scrypt ile özetlenir; web oturumu `HttpOnly` çerezde, mobil oturum ise yalnızca özetlenmiş biçimi MongoDB'ye yazılan rastgele anahtarla tutulur. Oturumlar 30 gün sonra sona erer.
- Hesap, giriş, başarısız giriş ve çıkış kayıtları e-posta, IP adresi, kullanıcı aracısı ve zaman bilgisiyle `audit_events` koleksiyonuna yazılır. Oturum IP kayıtları `sessions` koleksiyonundadır.
- AI danışma konuşmaları ve bitki analizi metin sonuçları `conversations` koleksiyonunda kullanıcıya özel saklanır. Bitki fotoğrafları kalıcı olarak veritabanına kaydedilmez.
- Ana sayfadaki hava durumu Open-Meteo'dan alınır; şehir arama veya cihaz konumu kullanılabilir. Akıllı öneri hava tahminine göre oluşturulur ve profesyonel tarımsal teşhis yerine geçmez.

## Mobil uygulama

Proje Capacitor ile Android ve iOS uygulama kabuğu sağlar. Android derlemek için Android Studio/Android SDK ve Java; iOS derlemek için macOS ve Xcode gerekir. iOS projesi Windows'ta oluşturulup eşitlenebilir, ancak derlenemez.

Android debug APK'sını `artifacts/tarim-asistani-debug.apk` konumundan indirip Android cihazda test edebilirsiniz. Bu APK test amaçlı debug imzasıyla oluşturulmuştur; Google Play dağıtımı için release imzası gerekir.

### API sunucusunu yayımlama

Mobil uygulamanın analiz yapabilmesi için uygulama sahibinin bir defa backend'i internette yayımlaması gerekir; uygulama kullanıcıları kendilerine ait sunucu açmaz. Hazır dağıtım ayarı [Render Blueprint](render.yaml) olarak eklenmiştir. Yayımlamak için:

1. [Render Blueprint oluşturma sayfasını](https://dashboard.render.com/blueprint/new?repo=https%3A%2F%2Fgithub.com%2Ferensnl%2Ftarim-asistani) açıp GitHub hesabınızla giriş yapın ve **Apply** ile `tarim-asistani-api` servisini oluşturun.
2. Render sizden `MONGODB_URI` ve `PLANTNET_API_KEY` değerlerini isteyecek. MongoDB Atlas bağlantı URI'sini ve [Pl@ntNet API hesabınızdan](https://my.plantnet.org/) aldığınız API anahtarını bu gizli alanlara girin. AI fikir danışma ve hastalık ön değerlendirmesi için `NVIDIA_API_KEY` değerini de Render Dashboard'da tanımlayın. Anahtarları kaynak koda veya mobil uygulamaya eklemeyin.
3. İlk dağıtım tamamlanıp health check başarılı olduktan sonra Render Dashboard'da servisi açın. Bu proje için API adresi `https://tarim-asistani-api.onrender.com` olarak ayarlanmıştır.
4. Güncel APK bu adresle yapılandırılmıştır. Farklı bir adres kullanırsanız uygulamadaki **API sunucusu adresi** alanına girip kaydedebilir veya yeni APK derlerken:

```bash
# PowerShell
$env:VITE_API_BASE_URL="https://tarim-asistani-api.onrender.com"
npm run mobile:sync
npm run mobile:android
```

Render'ın ücretsiz servisi bir süre istek almadığında uykuya geçebilir; yeniden açılması ilk analiz isteğini geciktirebilir. `VITE_` ile başlayan değişkenler mobil istemci paketine eklenir; Pl@ntNet veya NVIDIA API anahtarlarını hiçbir zaman bu şekilde eklemeyin. Android Studio'dan cihaz/emülatör seçerek çalıştırabilirsiniz. `npm run mobile:ios` komutu iOS projesini Xcode'da açar (macOS gerekir). `npm run mobile:sync` web uygulamasını derleyip Capacitor platformlarına kopyalar. Mobil uygulama kamera ve galeriden yaprak fotoğrafı seçebilir.

## Analiz akışı

- JPG, PNG ve WEBP görseli seçme, sürükleyip bırakma, mobil kamerayla çekme ve önizleme.
- Fotoğraf boyutu tarayıcıda kontrol edilir ve tarayıcı destekliyorsa analiz kopyası 2048 piksele küçültülür; bu işlem gönderim boyutunu ve analiz bekleme süresini azaltır, özgün dosyayı değiştirmez.
- API analiz isteği uzun süren model/bitki tanıma çağrılarına uygun zaman aşımı ve Türkçe bağlantı/yanıt hataları kullanır. Geçersiz veya aşırı büyük JSON isteklerine açık hata yanıtı döndürülür.
- Harici web fontu indirilmesi gerekmez; sistem yazı tipi yedeğiyle sayfa çevrimdışı ağlarda da metni hemen gösterebilir.
- API anahtarı yalnızca Express sunucusunda kalır; React uygulamasına gönderilmez.
- Bitki tanıma için sunucu fotoğrafı Pl@ntNet `v2/identify` servisine `leaf` organı olarak iletir. Tanınan bilimsel ad katalogdaki Türkçe/İngilizce adla eşleşiyorsa bu ad gösterilir; katalog dışı bitkilerde bilimsel ad kullanılır.
- Diğer Pl@ntNet sonuçları eşleşme puanlarıyla gösterilir. Bu puanlar doğrulanmış olasılık değildir; API'nin tür teşhisi her görüntüde doğru olmayabilir.
- NVIDIA anahtarı ayarlıysa, aynı görsel Pl@ntNet'in belirlediği bitki kimliğiyle birlikte yalnızca yaprak belirtilerini değerlendirmek için NVIDIA'ya da gönderilir. NVIDIA anahtarı yoksa tür tanıma çalışmaya devam eder; hastalık değerlendirmesi kullanılamaz olarak gösterilir.
- Pl@ntNet veya NVIDIA çıktısı kesin teşhis sayılmaz. Bitki kataloğu 53 kültür bitkisinin ad ve görsel ipuçlarını içerir; bu liste eğitim verisi değildir ve Türkiye'de yetiştirilen bütün bitkileri veya çeşitleri kapsamaz. Pancar/pazı gibi aynı türe ait çeşitler yalnızca yapraktan her zaman ayırt edilemez; %0 hata garantisi verilemez. Daha geniş doğruluk için uzmanlarca doğrulanmış etiketli görsellerle değerlendirme ve gerekirse modele ince ayar gerekir.
- Pl@ntNet anahtarı eksik/geçersizse, istek sınırı aşılırsa veya servis yanıt vermezse kullanıcıya anlaşılır hata gösterilir. Hastalık servisi kullanılamazsa bitki tanıma sonucu yine gösterilir.

## Gizlilik ve güvenli kullanım

Hesap ve güvenlik kayıtlarında e-posta adresi, IP adresi, kullanıcı aracısı ve zaman bilgisi; danışma geçmişinde gönderilen mesajlar ve AI yanıtları saklanır. AI danışma mesajları yanıt üretmek için NVIDIA API'ye iletilir. Bitki analizi istendiğinde fotoğraf Pl@ntNet'e gönderilir; `NVIDIA_API_KEY` sunucuda yapılandırılmışsa aynı fotoğraf belirtiler için ayrıca NVIDIA'ya iletilir. Fotoğraf dosyası MongoDB'ye kaydedilmez. Anahtarları `.env` içinde veya Render'ın gizli ortam değişkenlerinde saklayın; `.env` dosyasını paylaşmayın. Uygulama eşleşme puanını doğrulanmış olasılık olarak sunmaz; hastalık ön değerlendirmesi kesin teşhis değildir. Modelden ilaç veya pestisit reçetesi vermemesi istenir; bitki sağlığı kararlarında uzman görüşü alınmalıdır.
