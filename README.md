# Sudoku Duel

Ranked 1v1: ten sam sudoku dla obu graczy, wygrywa ten, kto pierwszy wypełni całą planszę.

## Funkcje

- **Profil i osiągnięcia:** awatar, opis (bez linków; moderacja może go wyczyścić), wizytówka z 3 osiągnięć, publiczny profil po kliknięciu nicku w rankingu. Lista osiągnięć to `ACH` w `server.js`, a warunki w `awardAfterGame`. Seria dni w Zagadce dnia. Obrazek wyniku z przyciskiem udostępniania.

- Zakładka **Co nowego** (`/zmiany`) z listą zmian, edytowaną z panelu właściciela.

- Strona **Jak grać** (`/zasady`) i formularz **Pomysł / błąd** (`/zglos`) ze zrzutem ekranu lub krótkim wideo.

- **Poziomy:** Łatwy (blokada 2 s po błędzie), Średni (4 s), Trudny (10 s) oraz **Hardcore** (plansza z trudnego, bez blokady i bez sprawdzania cyfr: błąd zostaje na planszy, wygrywa pierwszy z całą poprawną planszą).
- **Gra rankingowa** (tylko konta, Elo osobno na każdym poziomie) i **towarzyska** (każdy, bez rankingu).
- **Goście:** nick `Guest1234`, bez rankingu i bez historii. Nicki są unikalne, a `Guest…` jest zarezerwowany dla gości.
- **Solo**, **notatki w komórkach** (podwójne kliknięcie pustego pola, przycisk ✎ albo klawisz N), **rewanż** jednym kliknięciem, **pojedynek ze znajomym przez link** (bez rankingu).
- **Statystyki** (średni i najlepszy czas, passa wygranych, skuteczność), **wykres Elo** i **historia meczów** (ostatnie 50): ekran "Moje statystyki" w menu po zalogowaniu.
- **Zgłaszanie graczy** (🚩 w trakcie meczu i na ekranie wyniku), **panel admina z banami** (konto albo IP).
- **Wygląd:** motyw aplikacji (auto / ciemny / jasny), 4 motywy planszy (papier, drewno, neon, ocean), podświetlenie ukończonego rzędu, kolumny lub bloku (poza Hardcore), wyraźne odliczanie z "START!", konfetti po wygranej, dźwięki (generowane w przeglądarce, z przyciskiem wyciszenia). Ustawienia pod ⚙ w menu, zapisują się w przeglądarce.
- **Podgląd przeciwnika:** miniplansza w nagłówku meczu pokazuje, które pola rywal ma wypełnione (bez cyfr, także w Hardcore). Dotknięcie powiększa ją na środek ekranu. Można wyłączyć w ustawieniach.
- **Emotki:** 8 gotowych (👍 🔥 🤔 😅 😎 👏 🤝 😱), przycisk 💬 w meczu i na ekranie wyniku ("GG"). Bez wolnego tekstu, limit 1 na 1,5 s i 30 na mecz. Rywala można wyciszyć w ustawieniach.
- **Telefon / PWA:** układ dopasowany do małych ekranów i wcięć ekranu, aplikację można zainstalować (Android: przycisk w ustawieniach, iPhone: Udostępnij → Dodaj do ekranu początkowego). Bez internetu otwiera się zapisany ekran startowy, ale granie wymaga połączenia.
- **Rangi:** Brąz 🥉 (0+), Srebro 🥈 (1100+), Złoto 🥇 (1250+), Diament 💎 (1400+), liczone osobno na każdym poziomie. Pasek postępu w menu, komunikat o awansie/spadku po meczu, ikona rangi w rankingu i przy rywalu.
- **Sezony:** co miesiąc (czas polski) ranking się zeruje "miękko": Elo wraca w stronę 1000 (domyślnie zostaje 50% różnicy). TOP 3 na każdym poziomie (min. 5 meczów w sezonie) dostaje odznakę 🥇🥈🥉 widoczną w rankingu i w profilu. Tabela pokazuje tylko graczy, którzy grali w bieżącym sezonie.
- **Nowe tryby (na razie bez rankingu, w kolejce towarzyskiej i ze znajomym):** ⚡ **Blitz** (3 plansze pod rząd, wygrywa ten, kto weźmie 2), 📏 **Linie** (pierwszy, kto skompletuje 3 dowolne rzędy / kolumny / bloki 3×3), 🏁 **Sprint** (pierwszy, kto wstawi 20 poprawnych cyfr). Wybór pod poziomami trudności. Hardcore tylko w klasycznej. Cele i progi: `BLITZ_ROUNDS`, `LINE_TARGET`, `SPRINT_TARGET` w `server.js`.
- **Zagadka dnia (📅):** jedna plansza na każdy poziom na dobę (czas polski), taka sama dla wszystkich, jedna próba, osobna tabela czasów dla każdego poziomu i wczorajsi zwycięzcy. Czas mierzy serwer (od pierwszego pobrania planszy do wysłania poprawnego rozwiązania), więc odświeżenie strony nie resetuje zegara (rozwiązane pola wracają z pamięci przeglądarki). Wynik zapisują tylko konta, goście mogą zagrać dla zabawy. Czas niemożliwy dla człowieka (jak w grze rankingowej) jest odrzucany.
- **Znajomi i wyzwania (👥):** lista znajomych po nicku (tylko konta). Zaproszenie trzeba zaakceptować (można je odrzucić albo cofnąć, a wzajemne zaproszenia łączą od razu). Przy znajomych widać status: online, w grze, offline. Przycisk **Wyzwij** wysyła wyzwanie na wybrany w menu poziom i tryb. Wyzwany dostaje okienko z 60 s na odpowiedź, mecz jest bez rankingu. Limity: 50 znajomych, 20 oczekujących zaproszeń, antyspamowe limity zaproszeń i wyzwań.
- **Strony trybów:** menu główne to kafelki, a każdy tryb ma własną stronę z adresem (`/tryb/klasyczna`, `/tryb/blitz`, `/tryb/linie`, `/tryb/sprint`, ponadto `/zagadka` i `/znajomi`). Poziom trudności, rankingowa/towarzyska, solo i gra ze znajomym wybierasz na stronie trybu. Przycisk „wstecz" w przeglądarce działa.
- **Liczniki w meczu:** przy nicku rywala i przy „Ty" widać postęp (np. `7/20`). W trybie **Linie** plansza nie ma dodatkowych obramowań – liczy się każdy skompletowany rząd, kolumna lub blok.
- **Podgląd plansz z historii:** kliknij mecz w „Moje statystyki", żeby zobaczyć końcową planszę swoją i rywala (błędne cyfry na czerwono). Dotyczy meczów rozegranych po tej aktualizacji.
- **⏱ Na czas** (`/tryb/na-czas`): wybierasz 30 s, 1, 2 albo 5 min. Wygrywa ten, kto w tym czasie wstawi więcej poprawnych cyfr (remis: mniej błędów, potem kto wcześniej zdobył ostatnie pole). Skończysz planszę, od razu dostajesz następną, a rywal gra swoją. Obaj dostają te same plansze w tej samej kolejności. Timer odlicza w dół i robi się czerwony w ostatnich 10 s. Bez rankingu.
- **🤖 Trening z botem:** przycisk na stronie każdego trybu (poza Hardcore): Początkujący, Średni albo Mistrz. Bot wstawia cyfry w ludzkim, losowym tempie, czasem się myli i dostaje blokadę. Zawsze bez rankingu, nie trafia do bazy ani do zgłoszeń, w historii ma ikonę 🤖. Gdy w kolejce nikogo nie ma przez 20 s, pojawia się przycisk „Zagraj z botem". Parametry botów: `BOT_LEVELS` w `server.js`.
- Konta: nick + hasło albo Google, trwała baza Postgres, powrót do meczu po odświeżeniu strony (30 s), ochrona przed botami.

Statystyki, passa i wykres liczą **tylko mecze rankingowe** (nowe tryby i zagadka dnia ich nie zmieniają). Czasy: tylko z rozwiązanych plansz (nie z poddania ani rozłączenia). Historia zawiera wszystkie mecze konta (też towarzyskie i ze znajomym, z oznaczeniem trybu).

## Pliki

```
package.json
server.js            # gra, matchmaking, Elo, konta, baza, statystyki, zgłoszenia, bany
public/index.html    # gra
public/sw.js, manifest.webmanifest, icon-*.png, icon.svg   # aplikacja na telefon (PWA)
public/admin.html    # panel admina (/admin.html)
```

## Zmienne środowiskowe (Render → Environment)

| Zmienna | Po co | Wymagana? |
|---|---|---|
| `DATABASE_URL` | adres Postgres (Neon), żeby dane przetrwały restarty | tak (na serio) |
| `ADMIN_PASSWORD` | hasło do panelu `/admin.html`. Bez niego panel jest wyłączony | zalecane |
| `SEASON_KEEP` | ile różnicy od 1000 zostaje po resecie sezonu: `1` = brak resetu, `0.5` = połowa (domyślnie), `0` = pełny reset | nie |
| `GOOGLE_CLIENT_ID` | przycisk "Zaloguj przez Google" | nie |
| `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET` | captcha przy zakładaniu konta | nie (zalecane) |

Tabele (`users`, `reports`, `bans`, `meta`) tworzą się same. Konfiguracja Neon, Google i Turnstile: bez zmian względem poprzedniej wersji (Neon: neon.tech → Connect → connection string → `DATABASE_URL`).

## Panel właściciela (`/owner.html`)

Ustaw w Render → Environment zmienną **`OWNER_PASSWORD`** (inna niż `ADMIN_PASSWORD`). Wejdź na `https://twoja-gra.onrender.com/owner.html`.
Właściciel ma wszystko, co admin (bez limitów: bany także na stałe), a do tego: statystyki, ogłoszenia dla graczy, **podgląd meczów na żywo** (obie plansze), pełną kartę gracza (zmiana Elo, wiadomość, usunięcie konta), edycję listy „Co nowego" i opisów trybów, **reset rankingu** (wszystko lub jeden poziom, z potwierdzeniem `RESET`) oraz dziennik, kto z panelu co zrobił.
Admin (`/admin.html`) ma: zgłoszenia i bany czasowe (maks. 30 dni), ostrzeżenia, zerowanie unieważnionych meczów, pomysły i błędy od graczy.

## Panel admina

1. W Render dodaj `ADMIN_PASSWORD` (długie, losowe hasło) i poczekaj na restart.
2. Wejdź na `https://twoja-gra.onrender.com/admin.html` i wpisz to hasło.
3. Widzisz zgłoszenia pogrupowane po graczu (liczba zgłoszeń, powody, opisy, IP, ile meczów unieważnił system anty-botowy). Do wyboru:
   - **Zablokuj konto**: gracz jest od razu rozłączony, nie zaloguje się, znika z rankingu. Mecz, który właśnie grał, zostaje unieważniony dla przeciwnika.
   - **Zablokuj IP**: dla gości i osób, które zakładają nowe konta. Uwaga: pod jednym IP może siedzieć wiele osób (szkoła, sieć komórkowa), więc używaj oszczędnie.
   - **Odrzuć zgłoszenia**.
   - Każda blokada ma **czas**: 1 godzina, 24 godziny, 3 dni, 7 dni, 30 dni lub na stałe (tylko konta). Gracz widzi, do kiedy jest zablokowany.
   - **Ostrzeż**: gracz dostaje okno z Twoim komunikatem, które znika dopiero po kliknięciu „Rozumiem" (także po ponownym wejściu).
4. Na górze panelu: **statystyki** (online, mecze, konta, aktywni 24 h/7 dni), **ogłoszenie dla graczy** (pasek na górze gry na 15 min – 24 h) oraz **pomysły i błędy od graczy** (zgłoszenia z zakładki „💡 Pomysł / błąd", ze zrzutem ekranu lub wideo do 30 s / 10 MB; przyciski Załatwione / Usuń). Załączniki trzymane są w Postgresie (tabela `media`) lub w folderze `media` obok `data.json`; łącznie do ok. 150 MB, starsze znikają. Zgłoszenia kasują się po 45 dniach (załatwione po 7).
5. Sekcja "Sprawdź gracza" pokazuje dane po nicku i pozwala zablokować lub ostrzec go ręcznie oraz wyzerować licznik unieważnionych meczów. Lista blokad ma przycisk **Odblokuj**.

Zgłoszenia starsze niż 60 dni (odrzucone: 7 dni) i wygasłe blokady IP kasują się same. Adresy IP są przechowywane tylko w zgłoszeniach i blokadach.

## Uruchomienie lokalnie

```bash
npm install
npm start      # http://localhost:3000
```

## Ustawienia w `server.js` (góra pliku)

Progi rang: `RANKS`, minimum meczów do odznak: `SEASON_MIN_GAMES`. `DIFFS` (liczba pustych pól i długość blokady), `GRACE_MS` (czas na powrót do meczu), `HISTORY_MAX` i `ELO_LOG_MAX` (ile historii pamiętamy), progi anty-botowe `MIN_MOVE_MS`, `MIN_MS_PER_CELL`, `FLAGS_HIDE`.

## Ograniczenia anty-botowe (uczciwie)

W zagadce dnia błąd blokuje planszę tak jak w grze (czas blokady zależy od poziomu), a liczba błędów i wpisane cyfry wracają po wyjściu i powrocie.

Zagadka dnia jest jednoosobowa i przeglądarka dostaje rozwiązanie (potrzebne do sprawdzania cyfr na bieżąco), więc zdeterminowana osoba może je podejrzeć. Odsiewa to tylko limit szybkości (min. 0,4 s na pole) i panel admina. Jeśli kiedyś będzie to problem, można przenieść sprawdzanie cyfr na serwer.

Serwer sam sprawdza każdą cyfrę, ale bot z solverem może grać "po ludzku wolno". Odsiewamy proste boty: ruchy częstsze niż co 120 ms są ignorowane, wygrana szybsza niż 0,4 s na pole jest unieważniana (bez zmiany Elo), a konto z 3 unieważnieniami znika z rankingu. Resztą zajmują się zgłoszenia graczy i panel admina. Limity po IP są "best effort" (adres IP jest brany z nagłówka `X-Forwarded-For`).
