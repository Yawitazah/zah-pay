// Stripe transport stays in ZAH Pay; durable checkout/order state belongs to Commerce.
export class PaymentProblem extends Error { constructor(status,message){super(message);this.status=status;} }
const reject=()=>{throw new PaymentProblem(409,'Payment needs review. No fulfillment was submitted.');};
const integer=n=>Number.isSafeInteger(n)&&n>=0;
export function makeCommercePayments({stripe,origin,merchantId,accountId,livemode,webhookSecret,cryptoProvider}){
 if(!stripe||new URL(origin).protocol!=='https:'||!merchantId||!accountId||typeof livemode!=='boolean')throw new Error('Payment configuration required.');
 function totals(s){if(!integer(s.unitPriceCents)||!Number.isSafeInteger(s.quantity)||s.quantity<1||s.quantity>10||!integer(s.shippingCents)||s.currency!=='USD'||s.taxPolicy!=='off_by_owner'||s.taxCents!==0)reject();return s.unitPriceCents*s.quantity+s.shippingCents;}
 function metadata(s){return {zah_commerce:'1',merchant_id:merchantId,checkout_id:s.id};}
 return {
  async create(s,token){
   const total=totals(s);if(!s.id||!s.serviceId||!token||!integer(total))reject();
   const letters=s.id.replace(/-/g,'').slice(0,8).split('').map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
   const ship=s.recipient;
   return stripe.checkout.sessions.create({mode:'payment',integration_identifier:'zah_merch_'+letters,
    client_reference_id:s.id,metadata:metadata(s),payment_intent_data:{metadata:metadata(s)},
    customer_email:s.email,adaptive_pricing:{enabled:false},automatic_tax:{enabled:false},
    line_items:[{price_data:{currency:'usd',unit_amount:s.unitPriceCents,product_data:{name:s.name,description:'Size '+s.size}},quantity:s.quantity}],
    shipping_options:[{shipping_rate_data:{type:'fixed_amount',display_name:s.serviceName.slice(0,100),fixed_amount:{amount:s.shippingCents,currency:'usd'},metadata:{printful_service:s.serviceId}}}],
    // Delivery was collected and quoted before this session. Do not let hosted Checkout
    // change it while retaining a rate for a different address. Billing can differ.
    custom_text:{submit:{message:('Deliver to '+ship.name+', '+ship.address1+', '+ship.city+', '+(ship.state_code?ship.state_code+' ':'')+ship.zip+', '+ship.country_code+'. To change delivery, return to the store before paying.').slice(0,1000)}},
    success_url:origin+'/order.html#'+token,cancel_url:origin+'/checkout.html?size='+encodeURIComponent(s.size),
    expires_at:Math.floor(s.expiresAt/1000)
   },{idempotencyKey:'zah-commerce:'+merchantId+':'+s.id});
  },
  async retrieve(id){return stripe.checkout.sessions.retrieve(id,{expand:['line_items','shipping_cost.shipping_rate','payment_intent']});},
  validate(session,s){
   const total=totals(s),m=metadata(s),pi=session.payment_intent;
   if(session.livemode!==livemode||session.mode!=='payment'||session.client_reference_id!==s.id||Object.entries(m).some(([k,v])=>session.metadata?.[k]!==v)||session.currency!=='usd'||session.amount_subtotal!==s.unitPriceCents*s.quantity||session.amount_total!==total||session.total_details?.amount_shipping!==s.shippingCents||session.total_details?.amount_tax!==0||session.total_details?.amount_discount!==0)reject();
   const lines=session.line_items;if(lines?.has_more||lines?.data?.length!==1)reject();
   const line=lines.data[0];if(line.quantity!==s.quantity||line.price?.unit_amount!==s.unitPriceCents||line.price?.currency!=='usd')reject();
   if(session.shipping_cost?.shipping_rate?.metadata?.printful_service!==s.serviceId||session.shipping_cost?.amount_total!==s.shippingCents)reject();
   if(session.payment_status!=='paid')return {paid:false};
   if(session.status!=='complete'||!pi||typeof pi!=='object'||pi.status!=='succeeded'||pi.amount!==total||pi.amount_received!==total||pi.currency!=='usd'||pi.livemode!==livemode||Object.entries(m).some(([k,v])=>pi.metadata?.[k]!==v))reject();
   return {paid:true,paymentId:pi.id,totalCents:total};
  },
  async webhook(raw,signature){
   if(!webhookSecret)throw new PaymentProblem(503,'Payment verification is not configured.');
   let event;try{event=await stripe.webhooks.constructEventAsync(raw,signature,webhookSecret,undefined,cryptoProvider);}catch{throw new PaymentProblem(400,'Invalid payment signature.');}
   if(event.livemode!==livemode||(event.account&&event.account!==accountId))throw new PaymentProblem(400,'Invalid payment account.');
   return event;
  },
  async expire(id){return stripe.checkout.sessions.expire(id);}
 };
}
