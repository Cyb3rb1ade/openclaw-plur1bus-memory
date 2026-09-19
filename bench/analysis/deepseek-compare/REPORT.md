# deepseek-flash gegen die gespeicherten Kimi-Urteile

**Datum:** 2026-09-19 · **Stichprobe:** 20 der 691 heisenberg-Zeilen, die der
Pilot mit `kimi-for-coding-highspeed` bewertet hat; nach Textlänge
gleichmäßig durchgegriffen. Kimi wurde nicht erneut gefragt — sein Urteil
steht in der Datenbank. Rein lesend.

| Maß | DeepSeek vs. Kimi | Kimis Rauschboden (zwei identische Kimi-Läufe) |
|---|---|---|
| \|Δimportance\| | **0,064** (max 0,20) | 0,079 |
| dominante Emotion gleich | **95,0 %** | 76,8 % |
| L1 des Emotionsvektors | **0,119** | 0,412 |
| Mittlere Importance | 0,319 gegen Kimis 0,297 | — |

**Befund:** deepseek-flash stimmt mit Kimi enger überein, als Kimi mit sich
selbst übereinstimmt. Die Abweichung zwischen den beiden Modellen liegt
unterhalb der Streuung, die ein und dasselbe Modell zwischen zwei Läufen
erzeugt. Für diese Aufgabe sind sie austauschbar; kein systematischer Versatz
nach oben oder unten (0,319 gegen 0,297).

**Verbrauch je Zeile:** 594 Tokens rein, 337 raus, davon **271 Denken**
(80 %). Latenz 2,3 s. Für main + bernhardine (21.579 Zeilen) ergibt das
rund 12,8 Mio. Tokens rein und 7,3 Mio. raus.

20 von 20 Antworten sauber geparst, keine Abbrüche bei 1500 Tokens.
