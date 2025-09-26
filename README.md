# Speed-share

<div align="center">

![Speed-share Logo](https://github.com/user-attachments/assets/152c613b-f969-4aec-b959-7f871beba135)

**Fast, Secure, Peer-to-Peer File Sharing**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](https://github.com/username/speed-share/releases)
[![Powered By](https://img.shields.io/badge/Powered%20By-WebAssembly-654FF0.svg)](https://webassembly.org/)

<img src="https://github.com/user-attachments/assets/153c6d6b-bf9d-4480-a3c2-947b87f845f8" width="120px" alt="WebAssembly Logo">

</div>

## <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Travel%20and%20places/Rocket.png" width="25px" alt="Rocket"> Overview

Speed-share is a modern web application that enables seamless peer-to-peer file sharing with full end-to-end encryption. Transfer unlimited data files quickly and securely through a user-friendly interface.

## <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/refs/heads/master/Emojis/Activities/Sparkles.png" width="25px" alt="Sparkles"> Features

- <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Locked.png" width="20px" alt="Lock"> **End-to-End Encryption** - Toggle encryption on/off for complete privacy
- <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Gear.png" width="20px" alt="Gear"> **Customizable STUN Servers** - Configure network traversal settings for optimal connectivity
- <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Card%20File%20Box.png" width="20px" alt="File Box"> **Adjustable Chunk Size** - Modify file chunk size to optimize for your connection speed
- <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Control%20Knobs.png" width="20px" alt="Control"> **Recipient Controls** - Recipients can set maximum accepted file size
- <img src="https://github.com/user-attachments/assets/153c6d6b-bf9d-4480-a3c2-947b87f845f8" width="20px" alt="WebAssembly"> **WebAssembly Compression** - Uses WASM for efficient file compression and faster transfers
- <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Wastebasket.png" width="20px" alt="No Storage"> **Zero Server Storage** - Files transfer directly between peers with no intermediate storage
- <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Travel%20and%20places/Globe%20with%20Meridians.png" width="20px" alt="Cross Platform"> **Cross-Platform Compatibility** - Works across all modern browsers and devices

## <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Camera%20with%20Flash.png" width="25px" alt="Camera"> Screenshots

<div align="center">
  <img src="https://github.com/user-attachments/assets/ae6b9f8f-fae5-4833-a084-009382f9a881" width="45%" alt="Answer Screen"/>
  <img src="https://github.com/user-attachments/assets/8b924e9d-23a9-47c5-bd56-f59ad42b1476" width="45%" alt="Main Interface"/>

  <img src="https://github.com/user-attachments/assets/a314fc0c-39b8-404e-9023-58e2acbcfb5d" width="45%" alt="File Transfer"/>
  <img src="https://github.com/user-attachments/assets/e9f6b6ab-558e-418c-9e17-d6c0fee07b11" width="45%" alt="Connection Setup"/>

  <img src="https://github.com/user-attachments/assets/fbf388ae-14cc-46d2-94be-1262d8387d14" width="45%" alt="QR Code Sharing"/>
  <img src="https://github.com/user-attachments/assets/ca3a4dfa-8427-434d-9351-dcc641c9ddb1" width="45%" alt="Settings Panel"/>
  
  <img src="https://github.com/user-attachments/assets/8e3b5fd5-ebb1-4178-b11e-242974062b42" width="45%" alt="File Selection"/>
</div>

## <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/refs/heads/master/Emojis/Activities/Video%20Game.png" width="25px" alt="Game Controller"> How to Use

<div align="center">
  
[![Demo Video](https://img.shields.io/badge/Watch-Demo-red.svg?style=for-the-badge&logo=youtube)](https://github.com/user-attachments/assets/2f19252b-b55b-47db-8769-dd74f544c7fb)


</div>


```mermaid
C4Context
    Component(stun, "STUN Server")

    Boundary(b, "", "") {
        Person(bob, "Bob", "Bob Zero Share")
        Person(alice, "Alice", "Alice Zero Share")
    }

    Rel(alice, stun, "get ice candidates")
    UpdateRelStyle(alice, stun, $offsetX="-90", $offsetY="-40")

    Rel(bob, stun, "get ice candidates")
    UpdateRelStyle(bob, stun, $offsetX="-90", $offsetY="-40")

    BiRel(alice, bob, "file transfer")
    UpdateRelStyle(alice, bob, $offsetX="-30")
```

Example sequence, Alice want to send a file to Bob.

```mermaid
sequenceDiagram
    actor Alice
    actor Bob
    Alice-->>Alice: generate offer sdp
    Alice->>Bob: send offer link
    Bob-->>Bob: generate RSA keypair
    Bob-->>Bob: generate answer sdp
    Bob->>Alice: send answer sdp + RSA pub key
    Alice-->>Alice: encrypt file with AES key
    Alice-->>Alice: encrypt AES key with RSA pub key
    Alice->>Bob: send encrypted file + encrypted AES key
    Bob-->>Bob: decrypt file with decrypted AES key
```

### <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Hand%20gestures/Raising%20Hands.png" width="25px" alt="Sender"> For Senders:

1. Visit [Speed-share](https://speed-shares.vercel.app/)
2. Click "Generate Offer" to create a connection code
3. Share the code with your recipient by:
   - Clicking the copy button to get a text code
   - OR selecting "QR Code" to display a scannable QR code
4. Wait for the recipient to enter your code and send back their answer code
5. Enter the recipient's answer code to establish the connection
6. Select and send your files!

### <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Hand%20gestures/Open%20Hands.png" width="25px" alt="Recipient"> For Recipients:

1. Visit [Speed-share](https://speed-shares.vercel.app/)
2. Enter the sender's offer code or scan their QR code
3. Click "Generate Answer" to create your response code
4. Share your answer code with the sender
5. Wait for the connection to be established
6. Accept incoming files

## <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Gear.png" width="25px" alt="Gear"> Advanced Options

- <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Shield.png" width="20px" alt="Shield"> **Encryption Settings**: Toggle end-to-end encryption in the settings panel
- <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Travel%20and%20places/High-Speed%20Train.png" width="20px" alt="Speed"> **Chunk Size Adjustment**: Modify chunk size based on your network speed for optimal performance
- <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Satellite%20Antenna.png" width="20px" alt="Network"> **STUN Server Configuration**: Enter custom STUN server details for improved connectivity in restrictive networks
- <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Straight%20Ruler.png" width="20px" alt="Ruler"> **Max File Size**: Recipients can set maximum allowed file size to prevent unexpected large transfers

## <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Hammer%20and%20Wrench.png" width="25px" alt="Tools"> Technical Details

Speed-share leverages modern web technologies:

- <img src="https://upload.wikimedia.org/wikipedia/commons/d/d9/Node.js_logo.svg" width="20px" alt="WebRTC"> **WebRTC** for peer-to-peer connectivity
- <img src="https://github.com/user-attachments/assets/153c6d6b-bf9d-4480-a3c2-947b87f845f8" width="20px" alt="WebAssembly"> **WebAssembly** for efficient file compression
- <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Travel%20and%20places/Satellite.png" width="20px" alt="PWA"> **Progressive Web App** capabilities for offline functionality
- <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Mobile%20Phone.png" width="20px" alt="Responsive"> **Responsive design** for all device types

## <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/refs/heads/master/Emojis/Objects/Link.png" width="25px" alt="Link"> Links

- <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/refs/heads/master/Emojis/Animals/Spider%20Web.png" width="20px" alt="Web"> [Live Application](https://speed-shares.vercel.app/)
- <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Ladder.png" width="20px" alt="Issues"> [Report Issues](https://github.com/username/speed-share/issues)
- <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Desktop%20Computer.png" width="20px" alt="Source"> [Source Code](https://github.com/username/speed-share)

## <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Scroll.png" width="25px" alt="Scroll"> License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

<div align="center">
  <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Page%20with%20Curl.png" width="30px" alt="Documentation">
  
  [Documentation](https://github.com/username/speed-share/wiki) | 
  [Installation Guide](https://github.com/username/speed-share/wiki/installation) |
  [FAQ](https://github.com/username/speed-share/wiki/faq)
  
  <br>
  Made with <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Smilies/Red%20Heart.png" width="20px" alt="Heart"> by Speed-share Team
</div>