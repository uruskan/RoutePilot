# RoutePilot

Elite Dangerous için Türkçe masaüstü uygulaması ve komut satırı aracı. Galaksi Haritası'nda çizdiğiniz sistemler arası rotayı mevcut EDAP uçuş motoruyla takip eder: hizalanma, atlama, yakıt toplama ve yıldızdan güvenli ayrılma. Rota sonunda istasyon yaklaşması, docking veya gezegene iniş başlatmaz.

Normal kullanımda bağımsız bir Electron penceresi açılır. Masaüstü arayüzü ve CLI, aynı yerel `127.0.0.1:47856` servisini kullanır. RoutePilot hesabı veya bulut hizmeti gerekmez; bu depo yerel kullanım içindir ve uzaktan yayımlama yapılandırması içermez.

## Başlatma

1. Eski EDAP penceresini kapatın. RoutePilot aynı motorun `instance.lock` kilidini kullanır; ikinci motoru zorla açmaz.
2. Elite Dangerous'ta **AsterEDAP** kontrol profilini seçin. Ana geminizde Galaksi Haritası'ndan bir sistemler arası rota çizin ve sıradaki rota sistemini hedefleyin.
3. Supercruise'a geçin. İstasyona bağlı veya yüzeye inmiş olmayın; SRV ve yaya durumları desteklenmez. Başlangıç için yıldızdan yeterince uzaklaşın, gazı sıfırlayın ve harita/panelleri kapatarak kokpite dönün.
4. `Start-RoutePilot.cmd` dosyasına çift tıklayın. Başlatıcı gerektiğinde arayüzü derler ve RoutePilot masaüstü penceresini açar. Uygulamanın açılması uçuşu başlatmaz.
5. Kontroller hazır olduğunda **Rotayı başlat** düğmesine basın. İlk seferde modellerin yüklenmesi zaman alabilir. Başlatma isteği yalnızca bir kez bekletilir; yükleme sırasında **Başlatmayı iptal et** bu isteği iptal eder.
6. Uçuş boyunca Elite Dangerous görünür ve ön planda kalsın. Başka pencereye geçmek giriş korumasını tetikler; uçuş kendiliğinden devam etmez. Durma nedenini kontrol edip yeniden açıkça başlatın.

Ana gemi, uçuş durumu, kokpit ve etkin rota koşulları hem panelde hem uçuş köprüsünde denetlenir. Panelin güncel veri göstermesi motorun çalıştığı anlamına gelmez. Bilinmeyen sayısal değerler tahmin edilmez. Sabit duran gemide `Status.json` zamanının eski olması tek başına hata sayılmaz.

## Durdurma ve kapatma

- **Durdur** düğmesi veya motor hazır olduktan sonra **Ctrl+Alt+End**, uçuş girişlerini durdurur. Yükleme sırasında paneldeki iptal düğmesini kullanın.
- Odak kaybında motor oyuna sıfır gaz gönderemeyebilir. Gerekirse Elite'e dönüp AsterEDAP profilindeki **X** ile gazı sıfırlayın.
- **RoutePilot masaüstü penceresini kapatmak**, yerel servisin ve uçuş motorunun kapanışını başlatır.
- Arayüzsüz servis kullanırken **`Stop-RoutePilot.cmd`** dosyasını çalıştırın veya CLI'dan `shutdown` gönderin. PowerShell karşılığı:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Stop-RoutePilot.ps1
```

Kapatma komutu önce uçuşu durdurur, ardından motoru kapatır. Ağır bir yerel model çağrısı hemen dönmeyebilir; giriş izni kapatılır, kapanış için sınırlı süre beklenir. Zorunlu işlem sonlandırmasında son kalibrasyon kaydı tamamlanamayabilir.

## Komut satırı kullanımı

Masaüstü penceresi açmadan yalnızca yerel servisi başlatmak için proje klasöründe:

```powershell
.\Start-RoutePilot.ps1 -Headless
```

`-NoBrowser`, arayüzsüz başlatma için eski ad olarak da desteklenir. Masaüstü zaten açıksa CLI aynı servise bağlanır; ikinci uçuş motoru oluşturmaz. CLI komutları tek başına servis başlatmaz.

`RoutePilot-CLI.cmd` varsayılan olarak durumu gösterir. Komut adı vererek, örneğin `RoutePilot-CLI.cmd durum` veya `RoutePilot-CLI.cmd durdur`, aynı işlemleri yapabilirsiniz. npm karşılıkları:

```powershell
npm.cmd run cli -- status
npm.cmd run cli -- watch
npm.cmd run cli -- start
npm.cmd run cli -- stop
npm.cmd run cli -- save
npm.cmd run cli -- shutdown
```

`status` mevcut durumu gösterir; `watch` güncellemeleri izler. `start` gerçek uçuş başlatma isteğidir ve masaüstü düğmesiyle aynı gemi, rota ve kokpit koşullarını denetler. `stop` uçuşu durdurur, servis açık kalır. `save` boşta olan motorun gemi ayarlarını kaydeder; `shutdown` servisi ve motoru kapatır. `watch` sırasında Ctrl+C yalnızca izlemeyi sonlandırır; uçuşu durdurmak için ayrıca `stop` gerekir.

Türkçe adlar: `durum`, `baslat`/`başlat`, `durdur`, `kaydet`, `kapat`, `izle`. `--help` yardım gösterir. Komutun kabul edilmesi işlemin tamamlandığı anlamına gelmez; sonucu `status` veya `watch` ile kontrol edin. Değişiklik komutları otomatik tekrar gönderilmez. Çıkış kodları: `0` başarılı istek, `1` reddedilme/geçersiz yanıt, `2` kullanım hatası, `3` bağlantı/zaman aşımı.

## Ayarlar ve kayıtlar

Mevcut motor kurulumu yeniden kullanılır: `D:/GameDev/Projects/EDAPGui`. Gemi kalibrasyonu `configs/ship_configs.json` içindedir; RoutePilot öğrenilen geçerli dönüş değerlerini uçuş döngüsü bittikten sonra otomatik kaydeder. Motor hazır ve boşta olduğunda **Ayarlar → Şimdi kaydet** de kullanılabilir. Yerel model çağrısı hâlâ tamamlanıyorsa yeni başlatma veya kayıt isteği reddedilebilir; istekler otomatik yeniden denenmez.

Kaydetmeden önce özgün gemi ayarları `D:/GameDev/Projects/EDAPGui/.aster/routepilot-backups/` altında yedeklenir. Sıfır/geçersiz eğri örnekleri bellekte filtrelenir; ilk değişiklik kaydında özgün dosya korunur. Başka bir işlem ayar dosyalarını değiştirmişse üzerine yazılmaz ve hata gösterilir. `AP.json` tercihleri ve OCR kalibrasyonu korunur; RoutePilot'un atlama sınırı olmadan rota izleme davranışı bu özel motor işleminde uygulanır.

Sunucu ve motor tanı kayıtları bu deponun `work/` klasörüne yazılır. Electron kullanıcı/oturum verileri `D:/GameDev/Cache/RoutePilot/desktop` altındadır. Oyun günlüğü, `Status.json` ve `NavRoute.json`, Windows kullanıcısının `Saved Games/Frontier Developments/Elite Dangerous` klasöründen okunur.

## Doğrulama durumu ve kapsam

Bu yeni masaüstü/CLI entegrasyonu ve Python köprüsüyle **henüz canlı uçuş tamamlanmadı**. Yeniden kullanılan yerel EDAP motoru daha önce Mandalay ile gerçek rotayı tamamladı; bu, yeni entegrasyonun canlı uçuş doğrulaması yerine geçmez. Kullanıcı oyundayken pencere açma, odak değiştirme veya ekran testi yapılmaz; masaüstünün görsel doğrulaması ayrıca yapılmalıdır.

Belge hazırlanırken **48 Node testi (sunucu, CLI ve masaüstü yaşam döngüsü) ve 47 Python köprü testi** geçiyordu. Bu testler geçici günlük dosyaları ve sahte motorlarla çalışır; oyuna giriş göndermez. Başlatma/iptal yaşam döngüsü, rota temizleme ve son varış, uygunluk koşulları, ortak işlem kilidi, kalibrasyon kaydı ve yalnızca sahip olunan Windows süreç ağacının kapanışı denetlenir. Gerçek motor, uçuş girişleri kapalı hazırlık denemesinde hazır duruma ulaşıp temiz kapandı; ayar dosyaları değişmedi. Electron çalışma ortamı penceresiz konsol testiyle doğrulandı. Ayrıntılar VALIDATION.md içindedir.

Arka planda uçuş, yüzeye iniş, istasyon yanaşması ve exobiology işlemleri bu sürümün kapsamında değildir. Ekran yakalama ve giriş koruması nedeniyle oyunun ön planda olması gerekir. Rota bitişinde süper seyir yaklaşma yardımına otomatik geçiş yapılmaz.

## Mimari

| Bölüm | Görev |
| --- | --- |
| `desktop/` | Electron ana işlemi ve bağımsız uygulama penceresi; pencere kapanınca servis/motor kapanışını yönetir. |
| `cli/` | Aynı yerel API üzerinden durum, izleme ve açık uçuş komutları. |
| `web/` | React, HTML/CSS ve Lucide simgeleri; Vite ile derlenir. |
| `public/` | Üretilen arayüz; Git'e alınmaz. |
| `server/` | Node.js standart kitaplığıyla yalnızca `127.0.0.1:47856` üzerinde HTTP sunucusu; motoru açmadan günlük telemetrisi okur. |
| `bridge/` | Mevcut EDAP venv'iyle çalışan Python JSONL köprüsü; motor yalnızca açık Başlat isteğiyle yüklenir. |
| `test/` | Giriş göndermeyen Node/Python testleri. |
| `work/` | Yerel çalışma ve tanı kayıtları; Git'e alınmaz. |

Motor komutları `start`, `stop`, `save`, `shutdown` ile sınırlıdır. HTTP değişiklik istekleri oturum anahtarı ve Origin denetimi kullanır; GET istekleri motoru başlatmaz. API ve süreç protokolü [CONTRACT.md](CONTRACT.md) içinde tanımlıdır. React arayüzü ve CLI oyun tuşlarını doğrudan yönetmez; Electron sayfasında Node erişimi kapalı, bağlam yalıtımı ve sandbox açıktır.

## Geliştirme

Bu bilgisayardaki mevcut Node.js/npm ve EDAP Python ortamını kullanın. Ayrı bir Python ortamı veya yeni model indirmesi gerekmez. Komutları `D:/GameDev/Projects/RoutePilot` içinde PowerShell'den çalıştırın:

```powershell
$env:electron_config_cache = 'D:/GameDev/Cache/RoutePilot/electron'
npm.cmd ci --cache D:/GameDev/Cache/RoutePilot/npm --no-fund --no-audit
node node_modules/electron/install.js
npm.cmd run build
npm.cmd start
```

`npm.cmd start` veya `npm.cmd run desktop` masaüstünü açar. `npm.cmd run serve` yalnızca yerel servisi başlatır; CLI geliştirmesi için kullanılabilir. React geliştirme sunucusu `npm.cmd run dev` ile `127.0.0.1:5173` üzerinde açılır ve çalışan yerel servise bağlanır. Bu geliştirici görünümü masaüstü uygulamasının kapanış davranışını sağlamaz; servisi ayrıca kapatın.

İlk bağımlılık kurulumu npm ve Electron çalışma zamanı indirmesi için ağ erişimi ister; kurulu bağımlılıklar ve modellerle normal kullanım yereldir. Arayüz değişikliklerinden sonra yeniden `npm.cmd run build` çalıştırın. Geliştirme sırasında canlı uçuş başlatmayın; kullanıcı oynarken arayüz/ekran testleri veya odak değiştiren işlemler yapmayın.

```powershell
npm.cmd test
& 'D:/GameDev/Projects/EDAPGui/venv/Scripts/python.exe' -m unittest discover -s test -p 'test_bridge*.py' -v
```

Test için `ED_AP.py` dosyasını doğrudan çalıştırmayın veya rastgele içe aktarmayın; bazı giriş yolları gerçek motor davranışı başlatabilir. Köprü testleri sahte motor ve geçici dosyalar kullanır. Arayüzsüz başlatma veya durum sorgulama uçuş başlatmaz.

## Lisans

Yeni RoutePilot kodu [MIT lisanslıdır](LICENSE). Kullanılan EDAP motorunun ve üçüncü taraf bileşenlerin atıfları [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) içindedir. Mevcut EDAP kurulumu, Python bağımlılıkları ve model dosyaları bu depoya kopyalanmaz.

## Ticaret tarayıcısı / Markets

Sol menüde **Ticaret tarayıcısı** açılır. **Refresh markets** ile Spansh'in son 8 günde güncellenmiş piyasa raporları toplanır; pencere ve yaş sınırı ayarlardan değiştirilebilir. Sayfa sayısı, ilerleme, son başarılı tarama, kaynak zamanı ve hatalar görünür. Başarısız veya iptal edilen tarama son başarılı raporu silmez.

Sonuçlar pencereye uyum sağlayan ticaret kartlarıdır. **Profit per load** mevcut planlama kapasitesiyle bir yükün kârını; **If all stock sells** tüm stok için koşullu toplamı ve gereken yük sayısını gösterir. Kaynak kimlikleri, kesin tutarlar ve talep **Trade details & checks** altında; düzenlenebilir gemi, bütçe ve filtreler **Ship & filters** altındadır. Aynı sistemdeki iki piyasa için **Same system / Supercruise required** yazılır: sıfır sistem mesafesi, sıfır uçuş mesafesi değildir. HIP 58832 için filo gemisiyle ulaşım ve doğrulanmış pist/izin/yüzey kısıtları kartta görünür. Ulaşım açıklamasındaki PTN bağlantısı sadece ilgili rehbere izin verir.

Arayüzde eski **Nearby trades (spreadsheet)** düğmesinin adı **Short trade routes**, ikinci düğmenin adı **Highest buyers** oldu; sorgular değişmedi. **Closest to me** oyuncudan satıcıya, **Shortest trade route** satıcıdan alıcıya mesafeyi sıralar. 850, 1420 ve 1920 piksel genişlikte, açık/kapalı ayrıntılarla görünmez renderer geometri kontrolleri geçti; masaüstü görüntüsü alınmadı ve oyuna giriş gönderilmedi.

Varsayılan **Nearby trades (spreadsheet)** sorgusu eski çalışma kitabıyla aynıdır: en az **100 t** satıcı stoku, iki piyasa da en fazla **48 saat** eski ve satıcıdan alıcıya en fazla **150 ly**. Alıcının talebi tüm satıcı stokunu karşılamalıdır. Sıralama tüm stokun koşullu toplam kârına, eşitlikte daha kısa rotaya göredir. **Highest buyers (spreadsheet)** ikinci çalışma sayfasının geniş sorgusudur: en az 1 t, en fazla 8 günlük veri ve mesafe sınırı yok. İkisi de tüm stok için en yüksek fiyat veren uygun alıcıyı seçer. Sonuçlar 100 satırlık sayfalarda gösterilir; eski kitabın ilk 200 satırıyla sınırlandırılmaz.

Sorgu düğmeleri ve sıralama seçimi kaydedilir; elle değiştirilen filtreler **Apply settings** ile diske yazılır. Sorgu değiştirmek gemi/bütçe girdilerini değiştirmez. Yeni kurulumda kitabın düzenlenebilir planlama girdileri kullanılır: **16 t**, **220M Cr**, **20M Cr rezerv**; bunlar canlı bakiye/kargo kapasitesi iddiası değildir. Eski kişisel ayarlar açılışta üzerine yazılmaz.

**Closest seller to me** günlükteki gerçek StarPos konumundan satıcıya mesafeyi hesaplar. **Shortest seller → buyer route** iki piyasa arasındaki mesafedir. Konum atlamayla güncellenir; oturum kapalıysa/bilinmiyorsa konuma bağlı sıralama kullanılamaz. Ayrıca kâr/ton, kâr/sefer, toplam stok kârı, mesafe, yaş, stok, iniş pisti ve izin filtreleri vardır. Alıcının talebi satıcının tüm stokunu karşılamalıdır. **Cargo capacity**, **Credits** ve **Credit reserve** elle belirlenen senaryo girdileridir; bilinmeyen değerler tahmin edilmez.

**Daily refresh** tercihini açıp **Apply settings** ile kaydedin. Günlük saat UTC'dir (Türkiye saati UTC+3). RoutePilot veya arayüzsüz servisi çalışırken yeniler; kapalıyken çalışmaz, sonraki açılışta kaçırılan yenilemeyi yapar. Tercih başlangıçta kapalıdır. Otomatik yenileme oyuna tuş göndermez.

```powershell
.\RoutePilot-CLI.cmd markets --help
.\RoutePilot-CLI.cmd markets refresh
.\RoutePilot-CLI.cmd markets status
.\RoutePilot-CLI.cmd markets list --sort closestSeller --maxPlayerDistanceLy 500 --requiredPad L
.\RoutePilot-CLI.cmd markets list --sort loadProfit --cargoCapacity 1232 --credits 220000000 --creditReserve 20000000
.\RoutePilot-CLI.cmd markets export .\work\trades.csv --sort closestSeller
.\RoutePilot-CLI.cmd markets daily on
.\RoutePilot-CLI.cmd markets cancel
```

CLI aynı çalışan servisi kullanır; ayrıca motor veya ikinci tarayıcı başlatmaz. `refresh` sırasında Ctrl+C yalnızca beklemeyi bırakır; taramayı durdurmak için `markets cancel` kullanın. `--no-wait` yenilemeyi başlatıp hemen döner. Geliştiriciler için `npm run markets:standalone -- --help` ayrı, arayüzsüz modülü gösterir; aynı depoya iki yazıcı açılmaz.

Piyasa verileri `work/markets/` altında saklanır. JSON, ayarlar ve CSV dışa aktarımı desteklenir; eski XLSX dosyası bu sürümde yenilenmez. CSV tüm filtrelenmiş sonuçları içerir, sadece görünen 100 satırı değil. Kaynak bağlantıları yalnızca tıklandığında varsayılan tarayıcıda açılır. Spansh kamuya açık oyuncu raporlarını sağlar; fiyatlar/stoklar canlı garanti veya rezervasyon değildir. Fırsatlar aynı alıcı talebini paylaşabilir, toplam kârları toplanmamalıdır.

Feature source: `features/markets/` (supplied scanner 1.0.0, integrated with a verified Drake-Class Carrier adapter fix). `npm test` runs both the host integration tests and the supplied scanner suite. No extra runtime dependencies were installed.

Blank screen on switching tabs was fixed on 2026-09-29. Close and reopen RoutePilot using Start-RoutePilot.cmd to load the rebuilt interface. An old running service is now reported with a restart instruction. The invisible renderer regression can be run with the installed Electron executable and scripts/check-desktop-navigation.cjs; it uses synthetic markets and cannot start flight.

An eight-day market cache can take around 20 seconds to read on a cold start. The headless launcher allows up to 60 seconds for readiness. A running service opens the desktop without reloading that cache.
