# demo.tape: the 30-second demo. Render with `vhs demo.tape` (https://github.com/charmbracelet/vhs).
# It feeds each guard one tool call that should be blocked and one that should pass.

Output demo.gif

Set Shell "bash"
Set FontSize 14
Set Width 1600
Set Height 560
Set Padding 20
Set TypingSpeed 40ms

Type "node demo.mjs"
Enter
Sleep 8s

Type "cat sample/force-push-blocked.json"
Enter
Sleep 4s
