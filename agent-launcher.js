/* A private agent drawer shared by the full dashboard pages. */
(function(){
  'use strict';
  if(document.getElementById('tigerAgentLaunch')||location.pathname==='/agent.html')return;
  if(!document.querySelector('link[href="/agent.css"]')){var css=document.createElement('link');css.rel='stylesheet';css.href='/agent.css';document.head.append(css);}
  var button=document.createElement('button');button.id='tigerAgentLaunch';button.type='button';button.className='agent-launch-button';button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls','tigerAgentDrawer');
  var icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('fill','none');icon.setAttribute('stroke','currentColor');icon.setAttribute('stroke-width','1.6');icon.setAttribute('aria-hidden','true');var path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M12 3l2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4z');icon.append(path);button.append(icon,document.createTextNode('Agent'));
  var dialog=document.createElement('dialog');dialog.id='tigerAgentDrawer';dialog.className='agent-drawer';dialog.setAttribute('aria-label','Tiger Foundation agent');
  var head=document.createElement('div');head.className='agent-drawer-head';var full=document.createElement('a');full.href='/agent.html';full.textContent='Open full page ↗';var close=document.createElement('button');close.type='button';close.className='agent-drawer-close';close.setAttribute('aria-label','Close agent');close.textContent='×';head.append(full,close);
  var frame=document.createElement('iframe');frame.title='Private portfolio agent';frame.referrerPolicy='same-origin';dialog.append(head,frame);document.body.append(button,dialog);
  var previousFocus=null,wasLocked=false;
  function focusAgent(){if(frame.contentWindow)frame.contentWindow.postMessage({type:'tiger-agent-focus'},location.origin);}
  function opened(){return dialog.open;}
  function finishClose(){button.setAttribute('aria-expanded','false');if(!wasLocked)document.documentElement.classList.remove('agent-drawer-open');if(previousFocus&&previousFocus.isConnected)previousFocus.focus();}
  function closeAgent(){if(opened())dialog.close();}
  button.addEventListener('click',function(){
    previousFocus=document.activeElement;wasLocked=document.documentElement.classList.contains('agent-drawer-open');
    if(!frame.hasAttribute('src'))frame.src='/agent.html?panel=1';
    dialog.showModal();document.documentElement.classList.add('agent-drawer-open');button.setAttribute('aria-expanded','true');close.focus();
    focusAgent();
  });
  close.addEventListener('click',closeAgent);dialog.addEventListener('close',finishClose);
  dialog.addEventListener('click',function(event){if(event.target===dialog){var rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeAgent();}});
  frame.addEventListener('load',function(){if(opened())focusAgent();});
  window.addEventListener('message',function(event){if(event.origin===location.origin&&event.source===frame.contentWindow&&event.data&&event.data.type==='tiger-agent-close')closeAgent();});
})();
